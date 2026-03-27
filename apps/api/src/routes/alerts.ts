/**
 * Alert list and detail routes.
 * Alerts are read-only from the API — they're created by the worker pipeline.
 * Ported from ChainAlert's alert patterns.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { alerts, detections, events } from '@sentinel/db/schema/core';
import { eq, and, gte, lte, sql, count, desc, or, ilike } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  detectionId: z.string().uuid().optional(),
  moduleId: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  triggerType: z.string().optional(),
  notificationStatus: z.enum(['pending', 'sent', 'partial', 'failed', 'no_channels']).optional(),
  search: z.string().max(255).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'id must be a numeric string'),
});

// ---------------------------------------------------------------------------
// GET /alerts — list with filters and pagination
// ---------------------------------------------------------------------------

router.get('/', requireScope('api:read'), validate('query', listQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof listQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(alerts.orgId, orgId)];
  if (query.detectionId) conditions.push(eq(alerts.detectionId, query.detectionId));
  if (query.severity) conditions.push(eq(alerts.severity, query.severity));
  if (query.triggerType) conditions.push(eq(alerts.triggerType, query.triggerType));
  if (query.notificationStatus) conditions.push(eq(alerts.notificationStatus, query.notificationStatus));
  if (query.search) {
    const escapedSearch = query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const term = `%${escapedSearch}%`;
    conditions.push(or(ilike(alerts.title, term), ilike(alerts.description, term))!);
  }
  if (query.from) conditions.push(gte(alerts.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lte(alerts.createdAt, new Date(query.to)));

  // Filter by moduleId via detection join
  if (query.moduleId) {
    conditions.push(sql`${alerts.detectionId} IN (
      SELECT id FROM detections WHERE module_id = ${query.moduleId} AND org_id = ${orgId}
    )`);
  }

  const where = and(...conditions);
  const offset = (query.page - 1) * query.limit;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: alerts.id,
      severity: alerts.severity,
      title: alerts.title,
      description: alerts.description,
      triggerType: alerts.triggerType,
      notificationStatus: alerts.notificationStatus,
      createdAt: alerts.createdAt,
      detectionId: alerts.detectionId,
      ruleId: alerts.ruleId,
      eventId: alerts.eventId,
      detectionName: sql<string | null>`(
        SELECT name FROM detections WHERE detections.id = ${alerts.detectionId}
      )`.as('detection_name'),
      moduleId: sql<string | null>`(
        SELECT module_id FROM detections WHERE detections.id = ${alerts.detectionId}
      )`.as('module_id'),
    })
      .from(alerts)
      .where(where)
      .orderBy(desc(alerts.createdAt))
      .limit(query.limit)
      .offset(offset),
    db.select({ total: count() }).from(alerts).where(where),
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
// GET /alerts/stats — dashboard aggregations
// ---------------------------------------------------------------------------

router.get('/stats', requireScope('api:read'), async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const [
    [{ total }],
    [{ today }],
    [{ thisWeek }],
    [{ activeDetections }],
    severityBreakdown,
    recent,
  ] = await Promise.all([
    db.select({ total: count() }).from(alerts).where(eq(alerts.orgId, orgId)),
    db.select({ today: count() }).from(alerts).where(and(
      eq(alerts.orgId, orgId),
      gte(alerts.createdAt, todayStart),
    )),
    db.select({ thisWeek: count() }).from(alerts).where(and(
      eq(alerts.orgId, orgId),
      gte(alerts.createdAt, weekStart),
    )),
    db.select({ activeDetections: count() }).from(detections).where(and(
      eq(detections.orgId, orgId),
      eq(detections.status, 'active'),
    )),
    db.select({
      severity: alerts.severity,
      count: count(),
    }).from(alerts)
      .where(eq(alerts.orgId, orgId))
      .groupBy(alerts.severity),
    db.select({
      id: alerts.id,
      severity: alerts.severity,
      title: alerts.title,
      createdAt: alerts.createdAt,
      detectionName: sql<string | null>`(
        SELECT name FROM detections WHERE detections.id = ${alerts.detectionId}
      )`.as('detection_name'),
    }).from(alerts)
      .where(eq(alerts.orgId, orgId))
      .orderBy(desc(alerts.createdAt))
      .limit(10),
  ]);

  return c.json({
    total, today, thisWeek, activeDetections,
    bySeverity: Object.fromEntries(severityBreakdown.map((r) => [r.severity, r.count])),
    recent,
  });
});

// ---------------------------------------------------------------------------
// GET /alerts/:id — single alert detail
// ---------------------------------------------------------------------------

router.get('/:id', requireScope('api:read'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const [alert] = await db.select({
    alert: alerts,
    detectionName: sql<string | null>`(
      SELECT name FROM detections WHERE detections.id = ${alerts.detectionId}
    )`.as('detection_name'),
  })
    .from(alerts)
    .where(and(eq(alerts.id, BigInt(id)), eq(alerts.orgId, orgId)))
    .limit(1);

  if (!alert) return c.json({ error: 'Alert not found' }, 404);

  // Load associated event if present
  let event = null;
  if (alert.alert.eventId) {
    const [row] = await db.select()
      .from(events)
      .where(eq(events.id, alert.alert.eventId))
      .limit(1);
    event = row ?? null;
  }

  return c.json({
    data: {
      ...alert.alert,
      detectionName: alert.detectionName,
      event,
    },
  });
});

export { router as alertsRouter };
