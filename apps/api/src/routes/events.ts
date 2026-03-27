/**
 * Event list routes.
 * Events are created by the worker pipeline; this is read-only.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { eq, and, gte, lte, count, desc } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

const listQuerySchema = z.object({
  moduleId: z.string().optional(),
  eventType: z.string().optional(),
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
