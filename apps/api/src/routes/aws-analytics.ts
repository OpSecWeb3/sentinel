/**
 * AWS analytics routes — read-only CloudTrail intelligence for MCP tools.
 * Reads the platform `events` table scoped to module_id='aws'. After the
 * aws_raw_events collapse all CloudTrail JSON lives in `events.payload`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { eq, and, gte, lte, sql, desc, count } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { awsIntegrations } from '@sentinel/db/schema/aws';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// JSONB extraction helpers — keep field paths in one place so route handlers
// stay readable and CloudTrail/EventBridge dual-shape handling lives here.
// ---------------------------------------------------------------------------

const F = {
  eventName: sql<string | null>`COALESCE(${events.payload}->>'eventName', ${events.payload}->>'detail-type')`,
  eventSource: sql<string | null>`COALESCE(${events.payload}->>'eventSource', ${events.payload}->>'source')`,
  awsRegion: sql<string | null>`COALESCE(${events.payload}->>'awsRegion', ${events.payload}->>'region')`,
  principalId: sql<string | null>`${events.payload}->'userIdentity'->>'principalId'`,
  userArn: sql<string | null>`${events.payload}->'userIdentity'->>'arn'`,
  userType: sql<string | null>`${events.payload}->'userIdentity'->>'type'`,
  accountId: sql<string | null>`COALESCE(${events.payload}->>'recipientAccountId', ${events.payload}->>'account')`,
  sourceIpAddress: sql<string | null>`${events.payload}->>'sourceIPAddress'`,
  errorCode: sql<string | null>`${events.payload}->>'errorCode'`,
  resources: sql<unknown>`${events.payload}->'resources'`,
};

// ---------------------------------------------------------------------------
// GET /aws/events — query AWS CloudTrail events
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

  const conditions = [eq(events.orgId, orgId), eq(events.moduleId, 'aws')];
  if (query.search) {
    const escaped = query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const term = `%${escaped}%`;
    conditions.push(sql`(
      ${events.payload}->>'eventName' ILIKE ${term}
      OR ${events.payload}->>'eventSource' ILIKE ${term}
      OR ${events.payload}->'userIdentity'->>'principalId' ILIKE ${term}
      OR ${events.payload}->'userIdentity'->>'arn' ILIKE ${term}
      OR ${events.payload}->>'sourceIPAddress' ILIKE ${term}
      OR ${events.payload}->>'errorCode' ILIKE ${term}
    )`);
  }
  if (query.eventName) conditions.push(sql`${events.payload}->>'eventName' = ${query.eventName}`);
  if (query.eventSource) conditions.push(sql`${events.payload}->>'eventSource' = ${query.eventSource}`);
  if (query.principalId) {
    conditions.push(sql`${events.payload}->'userIdentity'->>'principalId' = ${query.principalId}`);
  }
  if (query.region) conditions.push(sql`${events.payload}->>'awsRegion' = ${query.region}`);
  if (query.errorCode) conditions.push(sql`${events.payload}->>'errorCode' = ${query.errorCode}`);
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));
  if (query.resourceArn) {
    conditions.push(
      sql`(${events.payload}->'resources') @> ${JSON.stringify([{ ARN: query.resourceArn }])}::jsonb`,
    );
  }

  const offset = (query.page - 1) * query.limit;
  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: events.id,
      cloudTrailEventId: events.externalId,
      eventName: F.eventName,
      eventSource: F.eventSource,
      awsRegion: F.awsRegion,
      principalId: F.principalId,
      userArn: F.userArn,
      accountId: F.accountId,
      sourceIpAddress: F.sourceIpAddress,
      errorCode: F.errorCode,
      resources: F.resources,
      eventTime: events.occurredAt,
    })
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.occurredAt))
      .limit(query.limit)
      .offset(offset),
    db.select({ total: count() }).from(events).where(and(...conditions)),
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

  const conditions = [
    eq(events.orgId, orgId),
    eq(events.moduleId, 'aws'),
    sql`${events.payload}->'userIdentity'->>'principalId' = ${principalId}`,
  ];
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));

  const [timeline, summary] = await Promise.all([
    db.select({
      id: events.id,
      eventName: F.eventName,
      eventSource: F.eventSource,
      awsRegion: F.awsRegion,
      sourceIpAddress: F.sourceIpAddress,
      errorCode: F.errorCode,
      resources: F.resources,
      eventTime: events.occurredAt,
    })
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.occurredAt))
      .limit(200),
    db.select({
      eventName: F.eventName,
      errorCode: F.errorCode,
      count: count(),
    })
      .from(events)
      .where(and(...conditions))
      .groupBy(F.eventName, F.errorCode)
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
    eq(events.orgId, orgId),
    eq(events.moduleId, 'aws'),
    sql`(${events.payload}->'resources') @> ${JSON.stringify([{ ARN: query.resourceArn }])}::jsonb`,
  ];
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));

  const rows = await db.select({
    id: events.id,
    eventName: F.eventName,
    eventSource: F.eventSource,
    principalId: F.principalId,
    userArn: F.userArn,
    awsRegion: F.awsRegion,
    sourceIpAddress: F.sourceIpAddress,
    errorCode: F.errorCode,
    eventTime: events.occurredAt,
  })
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.occurredAt))
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
    eq(events.orgId, orgId),
    eq(events.moduleId, 'aws'),
    sql`${events.payload}->>'errorCode' IS NOT NULL`,
  ];
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));

  const rows = await db.select({
    principalId: F.principalId,
    eventName: F.eventName,
    errorCode: F.errorCode,
    count: count(),
  })
    .from(events)
    .where(and(...conditions))
    .groupBy(F.principalId, F.eventName, F.errorCode)
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

  const conditions = [eq(events.orgId, orgId), eq(events.moduleId, 'aws')];
  if (query.from) conditions.push(gte(events.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.occurredAt, new Date(query.to)));

  const rows = await db.select({
    principalId: F.principalId,
    userType: F.userType,
    eventCount: count(),
  })
    .from(events)
    .where(and(...conditions))
    .groupBy(F.principalId, F.userType)
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
