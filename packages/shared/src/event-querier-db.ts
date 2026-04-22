import { and, eq, gte, lte, inArray, sql, type Db } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import type { NormalizedEvent } from './rules.js';
import type { EventFilter } from './correlation-types.js';
import type { EventQuerier } from './event-querier.js';
import { evaluateConditions } from './conditions.js';

/**
 * Postgres-backed EventQuerier. Translates `EventFilter.conditions` whose
 * operator is `==` into a JSONB path predicate (`payload #>> path = value`)
 * so the index-aware path used by `/events/payload-search` is reused;
 * remaining conditions are evaluated in-process against the loaded rows.
 *
 * Only `occurred_at` is used for windowing so replays with adjusted
 * ingestion timestamps do not shift results.
 */
export function createDbEventQuerier(db: Db): EventQuerier {
  return {
    async findEvents(orgId, filter, windowStart, windowEnd, limit = 1) {
      const where = [
        eq(events.orgId, orgId),
        gte(events.occurredAt, windowStart),
        lte(events.occurredAt, windowEnd),
      ];

      if (filter.moduleId) where.push(eq(events.moduleId, filter.moduleId));
      if (filter.eventType) {
        const types = Array.isArray(filter.eventType) ? filter.eventType : [filter.eventType];
        where.push(types.length === 1 ? eq(events.eventType, types[0]) : inArray(events.eventType, types));
      }

      // Push down conditions whose values are primitive and operator is ==, which
      // is the shape the existing payload-search route exploits. Other shapes
      // (numeric comparisons, nested objects, !=) fall through to in-memory filtering.
      const pushed: Array<NonNullable<EventFilter['conditions']>[number]> = [];
      for (const cond of filter.conditions ?? []) {
        if (
          cond.operator === '==' &&
          (typeof cond.value === 'string' || typeof cond.value === 'number' || typeof cond.value === 'boolean') &&
          /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/.test(cond.field)
        ) {
          const pathArray = `{${cond.field.split('.').join(',')}}`;
          const val = String(cond.value);
          where.push(sql`${events.payload} #>> ${pathArray} = ${val}`);
          pushed.push(cond);
        }
      }

      const rows = await db
        .select()
        .from(events)
        .where(and(...where))
        .orderBy(events.occurredAt)
        .limit(Math.max(limit * 4, limit));

      const remaining = (filter.conditions ?? []).filter((c) => !pushed.includes(c));
      const normalized: NormalizedEvent[] = [];
      for (const row of rows) {
        const payload = row.payload as Record<string, unknown>;
        if (remaining.length > 0 && !evaluateConditions(payload, remaining)) continue;
        normalized.push({
          id: row.id,
          orgId: row.orgId,
          moduleId: row.moduleId,
          eventType: row.eventType,
          externalId: row.externalId,
          payload,
          occurredAt: row.occurredAt,
          receivedAt: row.receivedAt,
        });
        if (normalized.length >= limit) break;
      }
      return normalized;
    },
  };
}
