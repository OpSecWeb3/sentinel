/**
 * AWS analytics routes — read-only CloudTrail intelligence for MCP tools.
 * All queries scope by orgId on aws_raw_events.org_id.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { eq, and, gte, lte, sql, desc, count, isNotNull } from '@sentinel/db';
import { awsRawEvents, awsIntegrations } from '@sentinel/db/schema/aws';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// GET /aws/events — query raw CloudTrail events
// ---------------------------------------------------------------------------

const awsEventsSchema = z.object({
  search: z.string().max(255).optional(),
  eventName: z.string().optional(),
  eventSource: z.string().optional(),
  principalId: z.string().optional(),
  resourceArn: z.string().optional(),
  region: z.string().optional(),
  errorCode: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  page: z.coerce.number().int().positive().default(1),
});

router.get('/events', requireScope('api:read'), validate('query', awsEventsSchema), async (c) => {
  const query = getValidated<z.infer<typeof awsEventsSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(awsRawEvents.orgId, orgId)];
  if (query.search) {
    const escaped = query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const term = `%${escaped}%`;
    conditions.push(sql`(
      ${awsRawEvents.eventName} ILIKE ${term}
      OR ${awsRawEvents.eventSource} ILIKE ${term}
      OR ${awsRawEvents.principalId} ILIKE ${term}
      OR ${awsRawEvents.userArn} ILIKE ${term}
      OR ${awsRawEvents.sourceIpAddress} ILIKE ${term}
      OR ${awsRawEvents.errorCode} ILIKE ${term}
    )`);
  }
  if (query.eventName) conditions.push(eq(awsRawEvents.eventName, query.eventName));
  if (query.eventSource) conditions.push(eq(awsRawEvents.eventSource, query.eventSource));
  if (query.principalId) conditions.push(eq(awsRawEvents.principalId, query.principalId));
  if (query.region) conditions.push(eq(awsRawEvents.awsRegion, query.region));
  if (query.errorCode) conditions.push(eq(awsRawEvents.errorCode, query.errorCode));
  if (query.from) conditions.push(gte(awsRawEvents.eventTime, new Date(query.from)));
  if (query.to) conditions.push(lte(awsRawEvents.eventTime, new Date(query.to)));
  if (query.resourceArn) {
    conditions.push(sql`${awsRawEvents.resources} @> ${JSON.stringify([{ ARN: query.resourceArn }])}`);
  }

  const offset = (query.page - 1) * query.limit;
  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: awsRawEvents.id,
      cloudTrailEventId: awsRawEvents.cloudTrailEventId,
      eventName: awsRawEvents.eventName,
      eventSource: awsRawEvents.eventSource,
      awsRegion: awsRawEvents.awsRegion,
      principalId: awsRawEvents.principalId,
      userArn: awsRawEvents.userArn,
      accountId: awsRawEvents.accountId,
      sourceIpAddress: awsRawEvents.sourceIpAddress,
      errorCode: awsRawEvents.errorCode,
      resources: awsRawEvents.resources,
      eventTime: awsRawEvents.eventTime,
    })
      .from(awsRawEvents)
      .where(and(...conditions))
      .orderBy(desc(awsRawEvents.eventTime))
      .limit(query.limit)
      .offset(offset),
    db.select({ total: count() }).from(awsRawEvents).where(and(...conditions)),
  ]);

  return c.json({ data: rows, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } });
});

// ---------------------------------------------------------------------------
// GET /aws/principal/:principalId/activity — all actions by a principal
// ---------------------------------------------------------------------------

const principalActivitySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

router.get('/principal/:principalId/activity', requireScope('api:read'), validate('query', principalActivitySchema), async (c) => {
  const principalId = c.req.param('principalId')!;
  const query = getValidated<z.infer<typeof principalActivitySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(awsRawEvents.orgId, orgId), eq(awsRawEvents.principalId, principalId)];
  if (query.from) conditions.push(gte(awsRawEvents.eventTime, new Date(query.from)));
  if (query.to) conditions.push(lte(awsRawEvents.eventTime, new Date(query.to)));

  const [timeline, summary] = await Promise.all([
    db.select({
      id: awsRawEvents.id,
      eventName: awsRawEvents.eventName,
      eventSource: awsRawEvents.eventSource,
      awsRegion: awsRawEvents.awsRegion,
      sourceIpAddress: awsRawEvents.sourceIpAddress,
      errorCode: awsRawEvents.errorCode,
      resources: awsRawEvents.resources,
      eventTime: awsRawEvents.eventTime,
    })
      .from(awsRawEvents)
      .where(and(...conditions))
      .orderBy(desc(awsRawEvents.eventTime))
      .limit(200),
    db.select({
      eventName: awsRawEvents.eventName,
      errorCode: awsRawEvents.errorCode,
      count: count(),
    })
      .from(awsRawEvents)
      .where(and(...conditions))
      .groupBy(awsRawEvents.eventName, awsRawEvents.errorCode)
      .orderBy(desc(count()))
      .limit(1000),
  ]);

  return c.json({ principalId, summary, timeline });
});

// ---------------------------------------------------------------------------
// GET /aws/resource-history — all events touching a resource ARN
// ---------------------------------------------------------------------------

const resourceHistorySchema = z.object({
  resourceArn: z.string().min(1),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

router.get('/resource-history', requireScope('api:read'), validate('query', resourceHistorySchema), async (c) => {
  const query = getValidated<z.infer<typeof resourceHistorySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [
    eq(awsRawEvents.orgId, orgId),
    sql`${awsRawEvents.resources} @> ${JSON.stringify([{ ARN: query.resourceArn }])}`,
  ];
  if (query.from) conditions.push(gte(awsRawEvents.eventTime, new Date(query.from)));
  if (query.to) conditions.push(lte(awsRawEvents.eventTime, new Date(query.to)));

  const rows = await db.select({
    id: awsRawEvents.id,
    eventName: awsRawEvents.eventName,
    eventSource: awsRawEvents.eventSource,
    principalId: awsRawEvents.principalId,
    userArn: awsRawEvents.userArn,
    awsRegion: awsRawEvents.awsRegion,
    sourceIpAddress: awsRawEvents.sourceIpAddress,
    errorCode: awsRawEvents.errorCode,
    eventTime: awsRawEvents.eventTime,
  })
    .from(awsRawEvents)
    .where(and(...conditions))
    .orderBy(desc(awsRawEvents.eventTime))
    .limit(query.limit);

  return c.json({ resourceArn: query.resourceArn, count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /aws/error-patterns — systematic access denials grouped by principal+action
// ---------------------------------------------------------------------------

const errorPatternsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

router.get('/error-patterns', requireScope('api:read'), validate('query', errorPatternsSchema), async (c) => {
  const query = getValidated<z.infer<typeof errorPatternsSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [
    eq(awsRawEvents.orgId, orgId),
    isNotNull(awsRawEvents.errorCode),
  ];
  if (query.from) conditions.push(gte(awsRawEvents.eventTime, new Date(query.from)));
  if (query.to) conditions.push(lte(awsRawEvents.eventTime, new Date(query.to)));

  const rows = await db.select({
    principalId: awsRawEvents.principalId,
    eventName: awsRawEvents.eventName,
    errorCode: awsRawEvents.errorCode,
    count: count(),
  })
    .from(awsRawEvents)
    .where(and(...conditions))
    .groupBy(awsRawEvents.principalId, awsRawEvents.eventName, awsRawEvents.errorCode)
    .orderBy(desc(count()))
    .limit(query.limit);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /aws/top-actors — most active principals by event count
// ---------------------------------------------------------------------------

const topActorsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

router.get('/top-actors', requireScope('api:read'), validate('query', topActorsSchema), async (c) => {
  const query = getValidated<z.infer<typeof topActorsSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(awsRawEvents.orgId, orgId)];
  if (query.from) conditions.push(gte(awsRawEvents.eventTime, new Date(query.from)));
  if (query.to) conditions.push(lte(awsRawEvents.eventTime, new Date(query.to)));

  const rows = await db.select({
    principalId: awsRawEvents.principalId,
    userType: awsRawEvents.userType,
    eventCount: count(),
  })
    .from(awsRawEvents)
    .where(and(...conditions))
    .groupBy(awsRawEvents.principalId, awsRawEvents.userType)
    .orderBy(desc(count()))
    .limit(query.limit);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /aws/integrations/summary — account + integration health
// ---------------------------------------------------------------------------

router.get('/integrations/summary', requireScope('api:read'), async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const integrations = await db.select({
    id: awsIntegrations.id,
    name: awsIntegrations.name,
    accountId: awsIntegrations.accountId,
    isOrgIntegration: awsIntegrations.isOrgIntegration,
    regions: awsIntegrations.regions,
    enabled: awsIntegrations.enabled,
    status: awsIntegrations.status,
    errorMessage: awsIntegrations.errorMessage,
    lastPolledAt: awsIntegrations.lastPolledAt,
    nextPollAt: awsIntegrations.nextPollAt,
  })
    .from(awsIntegrations)
    .where(eq(awsIntegrations.orgId, orgId))
    .limit(1000);

  return c.json({ data: integrations });
});

export { router as awsAnalyticsRouter };
