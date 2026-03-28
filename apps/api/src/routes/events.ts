/**
 * Event list routes.
 * Events are created by the worker pipeline; this is read-only.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { eq, and, gte, lte, count, desc, sql, ilike } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

const listQuerySchema = z.object({
  moduleId: z.string().optional(),
  eventType: z.string().optional(),
  search: z.string().max(255).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const idParamSchema = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------------------
// GET /events — list with filters and pagination
// ---------------------------------------------------------------------------

router.get('/', requireScope('api:read'), validate('query', listQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof listQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(events.orgId, orgId)];
  if (query.moduleId) conditions.push(eq(events.moduleId, query.moduleId));
  if (query.eventType) conditions.push(eq(events.eventType, query.eventType));
  if (query.search) {
    const escapedSearch = query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const term = `%${escapedSearch}%`;
    conditions.push(sql`(${events.externalId} ILIKE ${term} OR ${events.eventType} ILIKE ${term} OR ${events.payload}::text ILIKE ${term})`);
  }
  if (query.from) conditions.push(gte(events.receivedAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.receivedAt, new Date(query.to)));

  const where = and(...conditions);
  const offset = (query.page - 1) * query.limit;

  const [rows, [{ total }]] = await Promise.all([
    db.select()
      .from(events)
      .where(where)
      .orderBy(desc(events.receivedAt))
      .limit(query.limit)
      .offset(offset),
    db.select({ total: count() }).from(events).where(where),
  ]);

  return c.json({
    data: rows,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /events/timeline — cross-module entity timeline (MCP: event-entity-timeline)
// ---------------------------------------------------------------------------

const timelineQuerySchema = z.object({
  entity: z.string().min(1).max(500),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

router.get('/timeline', requireScope('api:read'), validate('query', timelineQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof timelineQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const escaped = query.entity.replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const term = `%${escaped}%`;

  const conditions = [
    eq(events.orgId, orgId),
    sql`${events.payload}::text ILIKE ${term}`,
  ];
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));

  const rows = await db
    .select({
      id: events.id,
      moduleId: events.moduleId,
      eventType: events.eventType,
      externalId: events.externalId,
      occurredAt: events.occurredAt,
      receivedAt: events.receivedAt,
      payload: events.payload,
    })
    .from(events)
    .where(and(...conditions))
    .orderBy(events.occurredAt)
    .limit(query.limit);

  return c.json({ entity: query.entity, count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /events/frequency — daily counts grouped by module + type (MCP: event-frequency)
// ---------------------------------------------------------------------------

const frequencyQuerySchema = z.object({
  moduleId: z.string().optional(),
  eventType: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

router.get('/frequency', requireScope('api:read'), validate('query', frequencyQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof frequencyQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(events.orgId, orgId)];
  if (query.moduleId) conditions.push(eq(events.moduleId, query.moduleId));
  if (query.eventType) conditions.push(eq(events.eventType, query.eventType));
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));

  const rows = await db
    .select({
      date: sql<string>`DATE(${events.occurredAt})`.as('date'),
      moduleId: events.moduleId,
      eventType: events.eventType,
      count: count(),
    })
    .from(events)
    .where(and(...conditions))
    .groupBy(sql`DATE(${events.occurredAt})`, events.moduleId, events.eventType)
    .orderBy(sql`DATE(${events.occurredAt}) DESC`);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /events/payload-search — JSONB path field=value query (MCP: event-search-payload)
// ---------------------------------------------------------------------------

const payloadSearchQuerySchema = z.object({
  field: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/, 'field must be a dot-separated path of alphanumeric/underscore segments')
    .describe('Dot-notation JSON path, e.g. "address" or "sender.login"'),
  value: z.string().min(1).max(500),
  moduleId: z.string().optional(),
  eventType: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

router.get('/payload-search', requireScope('api:read'), validate('query', payloadSearchQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof payloadSearchQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const pathArray = `{${query.field.split('.').join(',')}}`;

  const conditions = [
    eq(events.orgId, orgId),
    sql`${events.payload} #>> ${pathArray} = ${query.value}`,
  ];
  if (query.moduleId) conditions.push(eq(events.moduleId, query.moduleId));
  if (query.eventType) conditions.push(eq(events.eventType, query.eventType));
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));

  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.occurredAt))
    .limit(query.limit);

  return c.json({ field: query.field, value: query.value, count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /events/:id — single event detail
// ---------------------------------------------------------------------------

router.get('/:id', requireScope('api:read'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const [event] = await db.select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.orgId, orgId)))
    .limit(1);

  if (!event) return c.json({ error: 'Event not found' }, 404);
  return c.json({ data: event });
});

export { router as eventsRouter };
