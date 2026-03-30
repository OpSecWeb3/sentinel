/**
 * POST /api/query — visual query builder endpoint.
 * Translates QueryState to Drizzle conditions and returns paginated results.
 */
import { Hono } from 'hono';
import { getDb } from '@sentinel/db';
import { events, alerts } from '@sentinel/db/schema/core';
import { count, sql } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';
import { queryStateSchema, isTopLevelColumn } from '@sentinel/shared/query';
import type { QueryState, Clause, ClauseGroup, Collection } from '@sentinel/shared/query';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TableRef = typeof events | typeof alerts;

function getTable(collection: Collection): TableRef {
  return collection === 'events' ? events : alerts;
}

function getTimestampCol(collection: Collection) {
  return collection === 'events' ? events.receivedAt : alerts.createdAt;
}

/** Resolve a column reference from a field name */
function columnRef(table: TableRef, collection: Collection, field: string): ReturnType<typeof sql> | null {
  if (collection === 'events') {
    const t = table as typeof events;
    switch (field) {
      case 'id': return sql`${t.id}`;
      case 'orgId': return sql`${t.orgId}`;
      case 'moduleId': return sql`${t.moduleId}`;
      case 'eventType': return sql`${t.eventType}`;
      case 'externalId': return sql`${t.externalId}`;
      case 'occurredAt': return sql`${t.occurredAt}`;
      case 'receivedAt': return sql`${t.receivedAt}`;
      default: return null;
    }
  }
  const t = table as typeof alerts;
  switch (field) {
    case 'id': return sql`${t.id}`;
    case 'orgId': return sql`${t.orgId}`;
    case 'detectionId': return sql`${t.detectionId}`;
    case 'ruleId': return sql`${t.ruleId}`;
    case 'eventId': return sql`${t.eventId}`;
    case 'severity': return sql`${t.severity}`;
    case 'title': return sql`${t.title}`;
    case 'description': return sql`${t.description}`;
    case 'triggerType': return sql`${t.triggerType}`;
    case 'notificationStatus': return sql`${t.notificationStatus}`;
    case 'createdAt': return sql`${t.createdAt}`;
    default: return null;
  }
}

/** Build a JSONB #>> path expression for payload fields */
function payloadRef(table: TableRef, field: string): ReturnType<typeof sql> {
  const jsonPath = field.startsWith('payload.') ? field.slice(8) : field;
  const pathArray = `{${jsonPath.split('.').join(',')}}`;
  const payloadCol = 'payload' in table ? (table as typeof events).payload : (table as typeof alerts).triggerData;
  return sql`${payloadCol} #>> ${pathArray}`;
}

function fieldRef(table: TableRef, collection: Collection, field: string): ReturnType<typeof sql> {
  if (isTopLevelColumn(collection, field)) {
    return columnRef(table, collection, field)!;
  }
  return payloadRef(table, field);
}

function clauseToSql(table: TableRef, collection: Collection, clause: Clause): ReturnType<typeof sql> {
  const ref = fieldRef(table, collection, clause.field);
  const val = Array.isArray(clause.value) ? clause.value : clause.value;

  switch (clause.operator) {
    case 'eq':
      return sql`${ref} = ${val as string}`;
    case 'neq':
      return sql`${ref} != ${val as string}`;
    case 'contains': {
      const escaped = (val as string).replace(/[%_\\]/g, (ch) => `\\${ch}`);
      return sql`${ref}::text ILIKE ${'%' + escaped + '%'}`;
    }
    case 'not_contains': {
      const escaped = (val as string).replace(/[%_\\]/g, (ch) => `\\${ch}`);
      return sql`${ref}::text NOT ILIKE ${'%' + escaped + '%'}`;
    }
    case 'gt':
      return sql`${ref} > ${val as string}`;
    case 'lt':
      return sql`${ref} < ${val as string}`;
    case 'gte':
      return sql`${ref} >= ${val as string}`;
    case 'lte':
      return sql`${ref} <= ${val as string}`;
    case 'exists':
      return sql`${ref} IS NOT NULL`;
    case 'not_exists':
      return sql`${ref} IS NULL`;
    case 'in': {
      const vals = Array.isArray(clause.value) ? clause.value : [clause.value];
      return sql`${ref} IN (${sql.join(vals.map(v => sql`${v}`), sql`, `)})`;
    }
    default:
      return sql`TRUE`;
  }
}

function groupToSql(table: TableRef, collection: Collection, group: ClauseGroup): ReturnType<typeof sql> {
  const conditions = group.clauses.map(c => clauseToSql(table, collection, c));
  if (conditions.length === 0) return sql`TRUE`;
  if (conditions.length === 1) return conditions[0];
  return group.logic === 'OR'
    ? sql`(${sql.join(conditions, sql` OR `)})`
    : sql`(${sql.join(conditions, sql` AND `)})`;
}

// ---------------------------------------------------------------------------
// POST /query
// ---------------------------------------------------------------------------

router.post('/', requireScope('api:read'), validate('json', queryStateSchema), async (c) => {
  const qs = getValidated<QueryState>(c, 'json');
  const orgId = c.get('orgId');
  const db = getDb();
  const table = getTable(qs.collection);
  const tsCol = getTimestampCol(qs.collection);

  // Base org scoping
  const orgCol = qs.collection === 'events'
    ? (table as typeof events).orgId
    : (table as typeof alerts).orgId;
  const conditions: ReturnType<typeof sql>[] = [sql`${orgCol} = ${orgId}`];

  // Time range
  if (qs.timeRange.from) conditions.push(sql`${tsCol} >= ${new Date(qs.timeRange.from)}`);
  if (qs.timeRange.to) conditions.push(sql`${tsCol} <= ${new Date(qs.timeRange.to)}`);

  // Clause groups (AND'd together)
  for (const group of qs.groups) {
    conditions.push(groupToSql(table, qs.collection, group));
  }

  const where = sql.join(conditions, sql` AND `);
  const offset = (qs.page - 1) * qs.limit;

  // --- Aggregation mode ---
  if (qs.aggregation) {
    const groupByCols = qs.aggregation.groupBy.map(f => fieldRef(table, qs.collection, f));
    const groupByAliases = qs.aggregation.groupBy.map((_f, i) => sql`${groupByCols[i]} AS ${sql.raw(`"group_${i}"`)}`);

    const countExpr = qs.aggregation.fn === 'count_distinct' && qs.aggregation.field
      ? sql`COUNT(DISTINCT ${fieldRef(table, qs.collection, qs.aggregation.field)})`
      : sql`COUNT(*)`;

    const selectCols = [...groupByAliases, sql`${countExpr} AS "count"`];

    const result = await db.execute(sql`
      SELECT ${sql.join(selectCols, sql`, `)}
      FROM ${table}
      WHERE ${where}
      GROUP BY ${sql.join(groupByCols, sql`, `)}
      ORDER BY "count" DESC
      LIMIT ${qs.limit} OFFSET ${offset}
    `);

    return c.json({
      data: [...result],
      meta: { aggregation: true, groupBy: qs.aggregation.groupBy },
    });
  }

  // --- Standard mode ---
  const orderCol = qs.orderBy
    ? fieldRef(table, qs.collection, qs.orderBy.field)
    : tsCol;
  const orderDir = qs.orderBy?.dir === 'asc' ? sql`ASC` : sql`DESC`;

  const [rows, totalResult] = await Promise.all([
    db.select()
      .from(table)
      .where(where)
      .orderBy(sql`${orderCol} ${orderDir}`)
      .limit(qs.limit)
      .offset(offset),
    db.select({ total: count() }).from(table).where(where),
  ]);

  const total = totalResult[0]?.total ?? 0;

  return c.json({
    data: rows,
    meta: {
      page: qs.page,
      limit: qs.limit,
      total,
      totalPages: Math.ceil(total / qs.limit),
    },
  });
});

export { router as queryRouter };
