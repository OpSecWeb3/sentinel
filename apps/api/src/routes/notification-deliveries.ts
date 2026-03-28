/**
 * Notification delivery routes — query delivery audit trail.
 * Deliveries are created by the worker alert-dispatch pipeline.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { notificationDeliveries, alerts } from '@sentinel/db/schema/core';
import { eq, and, gte, lte, sql, count, desc, inArray } from '@sentinel/db';
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
  alertId: z.string().regex(/^\d+$/, 'alertId must be a numeric string').optional(),
  channelId: z.string().optional(),
  channelType: z.enum(['email', 'slack', 'webhook', 'pagerduty']).optional(),
  status: z.enum(['pending', 'sent', 'failed']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'id must be a numeric string'),
});

// ---------------------------------------------------------------------------
// GET /notification-deliveries — list with filters and pagination
// ---------------------------------------------------------------------------

router.get('/', requireScope('api:read'), validate('query', listQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof listQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  // Notification deliveries don't have orgId directly — scope via alerts table
  const orgAlertIds = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(eq(alerts.orgId, orgId));

  const conditions = [inArray(notificationDeliveries.alertId, orgAlertIds)];

  if (query.alertId) conditions.push(eq(notificationDeliveries.alertId, BigInt(query.alertId)));
  if (query.channelId) conditions.push(eq(notificationDeliveries.channelId, query.channelId));
  if (query.channelType) conditions.push(eq(notificationDeliveries.channelType, query.channelType));
  if (query.status) conditions.push(eq(notificationDeliveries.status, query.status));
  if (query.from) conditions.push(gte(notificationDeliveries.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lte(notificationDeliveries.createdAt, new Date(query.to)));

  const where = and(...conditions);
  const offset = (query.page - 1) * query.limit;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: notificationDeliveries.id,
      alertId: notificationDeliveries.alertId,
      channelId: notificationDeliveries.channelId,
      channelType: notificationDeliveries.channelType,
      status: notificationDeliveries.status,
      statusCode: notificationDeliveries.statusCode,
      responseTimeMs: notificationDeliveries.responseTimeMs,
      error: notificationDeliveries.error,
      attemptCount: notificationDeliveries.attemptCount,
      sentAt: notificationDeliveries.sentAt,
      createdAt: notificationDeliveries.createdAt,
      alertTitle: sql<string | null>`(
        SELECT title FROM alerts WHERE alerts.id = ${notificationDeliveries.alertId}
      )`.as('alert_title'),
    })
      .from(notificationDeliveries)
      .where(where)
      .orderBy(desc(notificationDeliveries.createdAt))
      .limit(query.limit)
      .offset(offset),
    db.select({ total: count() }).from(notificationDeliveries).where(where),
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
// GET /notification-deliveries/stats — delivery success/failure aggregations
// ---------------------------------------------------------------------------

router.get('/stats', requireScope('api:read'), async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const orgAlertIds = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(eq(alerts.orgId, orgId));

  const orgScope = inArray(notificationDeliveries.alertId, orgAlertIds);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const [
    [{ total }],
    [{ thisWeek }],
    statusBreakdown,
    channelTypeBreakdown,
  ] = await Promise.all([
    db.select({ total: count() }).from(notificationDeliveries).where(orgScope),
    db.select({ thisWeek: count() }).from(notificationDeliveries).where(and(
      orgScope,
      gte(notificationDeliveries.createdAt, weekStart),
    )),
    db.select({
      status: notificationDeliveries.status,
      count: count(),
    }).from(notificationDeliveries)
      .where(orgScope)
      .groupBy(notificationDeliveries.status),
    db.select({
      channelType: notificationDeliveries.channelType,
      count: count(),
    }).from(notificationDeliveries)
      .where(orgScope)
      .groupBy(notificationDeliveries.channelType),
  ]);

  return c.json({
    total,
    thisWeek,
    byStatus: Object.fromEntries(statusBreakdown.map((r) => [r.status, r.count])),
    byChannelType: Object.fromEntries(channelTypeBreakdown.map((r) => [r.channelType, r.count])),
  });
});

// ---------------------------------------------------------------------------
// GET /notification-deliveries/:id — single delivery detail
// ---------------------------------------------------------------------------

router.get('/:id', requireScope('api:read'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const orgAlertIds = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(eq(alerts.orgId, orgId));

  const [delivery] = await db.select()
    .from(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.id, BigInt(id)),
      inArray(notificationDeliveries.alertId, orgAlertIds),
    ))
    .limit(1);

  if (!delivery) return c.json({ error: 'Delivery not found' }, 404);

  return c.json({ data: delivery });
});

export { router as notificationDeliveriesRouter };
