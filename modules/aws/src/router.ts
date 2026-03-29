/**
 * AWS module Hono router.
 * Manages integrations and exposes raw event data.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDb, eq, and, desc, count, sql } from '@sentinel/db';
import { awsIntegrations, awsRawEvents } from '@sentinel/db/schema/aws';
import { detections } from '@sentinel/db/schema/core';
import { encrypt } from '@sentinel/shared/crypto';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { templates } from './templates/index.js';

const log = rootLogger.child({ component: 'aws-router' });

export const awsRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// GET /modules/aws/integrations
// ---------------------------------------------------------------------------

awsRouter.get('/integrations', async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const rows = await db
    .select({
      id: awsIntegrations.id,
      name: awsIntegrations.name,
      accountId: awsIntegrations.accountId,
      isOrgIntegration: awsIntegrations.isOrgIntegration,
      awsOrgId: awsIntegrations.awsOrgId,
      sqsQueueUrl: awsIntegrations.sqsQueueUrl,
      sqsRegion: awsIntegrations.sqsRegion,
      regions: awsIntegrations.regions,
      enabled: awsIntegrations.enabled,
      status: awsIntegrations.status,
      errorMessage: awsIntegrations.errorMessage,
      lastPolledAt: awsIntegrations.lastPolledAt,
      pollIntervalSeconds: awsIntegrations.pollIntervalSeconds,
      hasRoleArn: sql<boolean>`(role_arn IS NOT NULL)`,
      hasCredentials: sql<boolean>`(credentials_encrypted IS NOT NULL)`,
      createdAt: awsIntegrations.createdAt,
    })
    .from(awsIntegrations)
    .where(eq(awsIntegrations.orgId, orgId))
    .orderBy(desc(awsIntegrations.createdAt))
    .limit(1000);

  // Fetch distinct account IDs seen in raw events per integration
  const seenAccounts = await db
    .select({
      integrationId: awsRawEvents.integrationId,
      accountId: awsRawEvents.accountId,
    })
    .from(awsRawEvents)
    .where(and(eq(awsRawEvents.orgId, orgId), sql`${awsRawEvents.accountId} IS NOT NULL`))
    .groupBy(awsRawEvents.integrationId, awsRawEvents.accountId)
    .limit(1000);

  const accountsByIntegration = seenAccounts.reduce<Record<string, string[]>>((acc, row) => {
    if (!acc[row.integrationId]) acc[row.integrationId] = [];
    if (row.accountId) acc[row.integrationId].push(row.accountId);
    return acc;
  }, {});

  return c.json({
    data: rows.map((r) => ({
      ...r,
      connectedAccounts: accountsByIntegration[r.id] ?? [],
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /modules/aws/integrations
// ---------------------------------------------------------------------------

const createIntegrationSchema = z.object({
  name: z.string().min(1).max(128),
  accountId: z.string().regex(/^\d{12}$/, 'AWS account ID must be 12 digits'),
  isOrgIntegration: z.boolean().default(false),
  awsOrgId: z.string().regex(/^o-[a-z0-9]{10,32}$/, 'AWS Org ID format: o-xxxxxxxxxx').optional(),
  roleArn: z.string().startsWith('arn:aws:iam::').optional(),
  externalId: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sqsQueueUrl: z.string().url().optional(),
  sqsRegion: z.string().default('us-east-1'),
  regions: z.array(z.string()).default([]),
  pollIntervalSeconds: z.number().int().min(30).max(3600).default(60),
});

awsRouter.post('/integrations', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);
  const body = await c.req.json();
  const parsed = createIntegrationSchema.safeParse(body);
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });

  const data = parsed.data;

  // Require either role ARN or access key credentials
  const hasRole = !!data.roleArn;
  const hasKey = !!(data.accessKeyId && data.secretAccessKey);
  if (!hasRole && !hasKey) {
    throw new HTTPException(400, { message: 'Provide either roleArn (recommended) or accessKeyId + secretAccessKey' });
  }

  let credentialsEncrypted: string | null = null;
  if (hasKey) {
    credentialsEncrypted = encrypt(JSON.stringify({
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
    }));
  }

  const db = getDb();
  const [row] = await db.insert(awsIntegrations).values({
    orgId,
    name: data.name,
    accountId: data.accountId,
    isOrgIntegration: data.isOrgIntegration,
    awsOrgId: data.awsOrgId ?? null,
    roleArn: data.roleArn ?? null,
    externalId: data.externalId ?? null,
    credentialsEncrypted,
    sqsQueueUrl: data.sqsQueueUrl ?? null,
    sqsRegion: data.sqsRegion,
    regions: data.regions,
    pollIntervalSeconds: data.pollIntervalSeconds,
    enabled: true,
    status: 'active',
  }).returning({
    id: awsIntegrations.id,
    name: awsIntegrations.name,
    accountId: awsIntegrations.accountId,
    status: awsIntegrations.status,
    createdAt: awsIntegrations.createdAt,
  });

  // Trigger initial SQS poll
  if (row.id) {
    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
    await queue.add('aws.sqs.poll', { integrationId: row.id, orgId }, { jobId: `aws-poll-init-${row.id}-${Date.now()}` });
  }

  return c.json({ data: row }, 201);
});

// ---------------------------------------------------------------------------
// GET /modules/aws/integrations/:id
// ---------------------------------------------------------------------------

awsRouter.get('/integrations/:id', async (c) => {
  const orgId = c.get('orgId');
  const { id } = c.req.param();
  const db = getDb();

  const [row] = await db
    .select({
      id: awsIntegrations.id,
      name: awsIntegrations.name,
      accountId: awsIntegrations.accountId,
      isOrgIntegration: awsIntegrations.isOrgIntegration,
      awsOrgId: awsIntegrations.awsOrgId,
      hasRoleArn: sql<boolean>`(role_arn IS NOT NULL)`,
      hasExternalId: sql<boolean>`(external_id IS NOT NULL)`,
      sqsQueueUrl: awsIntegrations.sqsQueueUrl,
      sqsRegion: awsIntegrations.sqsRegion,
      regions: awsIntegrations.regions,
      enabled: awsIntegrations.enabled,
      status: awsIntegrations.status,
      errorMessage: awsIntegrations.errorMessage,
      lastPolledAt: awsIntegrations.lastPolledAt,
      pollIntervalSeconds: awsIntegrations.pollIntervalSeconds,
      hasCredentials: sql<boolean>`(credentials_encrypted IS NOT NULL)`,
      createdAt: awsIntegrations.createdAt,
      updatedAt: awsIntegrations.updatedAt,
    })
    .from(awsIntegrations)
    .where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)))
    .limit(1);

  if (!row) throw new HTTPException(404, { message: 'Integration not found' });

  return c.json({ data: row });
});

// ---------------------------------------------------------------------------
// PATCH /modules/aws/integrations/:id
// ---------------------------------------------------------------------------

const patchIntegrationSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  isOrgIntegration: z.boolean().optional(),
  awsOrgId: z.string().nullable().optional(),
  sqsQueueUrl: z.string().url().nullable().optional(),
  sqsRegion: z.string().optional(),
  regions: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().min(30).max(3600).optional(),
  roleArn: z.string().startsWith('arn:aws:iam::').nullable().optional(),
  externalId: z.string().nullable().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
});

awsRouter.patch('/integrations/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Insufficient permissions' }, 403);
  const { id } = c.req.param();
  const body = await c.req.json();
  const parsed = patchIntegrationSchema.safeParse(body);
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });

  const db = getDb();
  const [existing] = await db
    .select({ id: awsIntegrations.id })
    .from(awsIntegrations)
    .where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)))
    .limit(1);

  if (!existing) throw new HTTPException(404, { message: 'Integration not found' });

  const updates: Record<string, unknown> = {};
  const d = parsed.data;

  if (d.name !== undefined) updates.name = d.name;
  if (d.isOrgIntegration !== undefined) updates.isOrgIntegration = d.isOrgIntegration;
  if (d.awsOrgId !== undefined) updates.awsOrgId = d.awsOrgId;
  if (d.sqsQueueUrl !== undefined) updates.sqsQueueUrl = d.sqsQueueUrl;
  if (d.sqsRegion !== undefined) updates.sqsRegion = d.sqsRegion;
  if (d.regions !== undefined) updates.regions = d.regions;
  if (d.enabled !== undefined) updates.enabled = d.enabled;
  if (d.pollIntervalSeconds !== undefined) updates.pollIntervalSeconds = d.pollIntervalSeconds;
  if (d.roleArn !== undefined) updates.roleArn = d.roleArn;
  if (d.externalId !== undefined) updates.externalId = d.externalId;

  const hasAccessKeyId = d.accessKeyId !== undefined;
  const hasSecretAccessKey = d.secretAccessKey !== undefined;
  if (hasAccessKeyId !== hasSecretAccessKey) {
    throw new HTTPException(400, {
      message: 'accessKeyId and secretAccessKey must both be provided when updating credentials',
    });
  }

  if (d.accessKeyId && d.secretAccessKey) {
    updates.credentialsEncrypted = encrypt(JSON.stringify({
      accessKeyId: d.accessKeyId,
      secretAccessKey: d.secretAccessKey,
    }));
  }

  await db.update(awsIntegrations).set(updates).where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)));

  // Trigger a poll so config changes take effect immediately
  if (updates.enabled !== false) {
    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
    await queue.add('aws.sqs.poll', { integrationId: id, orgId }, { jobId: `aws-poll-update-${id}-${Date.now()}` });
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /modules/aws/integrations/:id
// ---------------------------------------------------------------------------

awsRouter.delete('/integrations/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);
  const { id } = c.req.param();
  const db = getDb();

  // Clean up any pending poll jobs before deleting
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  const repeatableJobs = await queue.getRepeatableJobs();
  for (const rj of repeatableJobs) {
    if (rj.id?.includes(id)) {
      await queue.removeRepeatableByKey(rj.key);
    }
  }

  const result = await db.delete(awsIntegrations)
    .where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)));

  if ((result as unknown as { rowCount: number }).rowCount === 0) {
    throw new HTTPException(404, { message: 'Integration not found' });
  }

  // If this was the last active integration, pause all AWS detections for the org
  const [remaining] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(awsIntegrations)
    .where(and(eq(awsIntegrations.orgId, orgId), eq(awsIntegrations.enabled, true)));

  if ((remaining?.total ?? 0) === 0) {
    const paused = await db
      .update(detections)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(and(eq(detections.orgId, orgId), eq(detections.moduleId, 'aws'), eq(detections.status, 'active')))
      .returning({ id: detections.id });

    if (paused.length > 0) {
      log.warn({ orgId, pausedCount: paused.length }, 'Last active AWS integration deleted — paused all AWS detections');
    }
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /modules/aws/integrations/:id/poll — manually trigger a poll
// ---------------------------------------------------------------------------

awsRouter.post('/integrations/:id/poll', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Insufficient permissions' }, 403);
  const { id } = c.req.param();
  const db = getDb();

  const [row] = await db
    .select({ id: awsIntegrations.id, sqsQueueUrl: awsIntegrations.sqsQueueUrl })
    .from(awsIntegrations)
    .where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)))
    .limit(1);

  if (!row) throw new HTTPException(404, { message: 'Integration not found' });
  if (!row.sqsQueueUrl) throw new HTTPException(400, { message: 'No SQS queue URL configured' });

  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await queue.add('aws.sqs.poll', { integrationId: id, orgId });

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /modules/aws/events — list raw CloudTrail events (short-retention buffer)
// ---------------------------------------------------------------------------

awsRouter.get('/events', async (c) => {
  const orgId = c.get('orgId');
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const integrationId = c.req.query('integrationId');
  const eventNameFilter = c.req.query('eventName');

  const db = getDb();
  const conditions = [eq(awsRawEvents.orgId, orgId)];
  if (integrationId) conditions.push(eq(awsRawEvents.integrationId, integrationId));
  if (eventNameFilter) conditions.push(eq(awsRawEvents.eventName, eventNameFilter));

  const whereClause = and(...conditions);

  const [totalRow] = await db
    .select({ total: count() })
    .from(awsRawEvents)
    .where(whereClause);

  const rows = await db
    .select({
      id: awsRawEvents.id,
      integrationId: awsRawEvents.integrationId,
      cloudTrailEventId: awsRawEvents.cloudTrailEventId,
      eventName: awsRawEvents.eventName,
      eventSource: awsRawEvents.eventSource,
      awsRegion: awsRawEvents.awsRegion,
      principalId: awsRawEvents.principalId,
      userArn: awsRawEvents.userArn,
      userType: awsRawEvents.userType,
      sourceIpAddress: awsRawEvents.sourceIpAddress,
      errorCode: awsRawEvents.errorCode,
      userAgent: awsRawEvents.userAgent,
      eventVersion: awsRawEvents.eventVersion,
      resources: awsRawEvents.resources,
      eventTime: awsRawEvents.eventTime,
      receivedAt: awsRawEvents.receivedAt,
      promoted: awsRawEvents.promoted,
      platformEventId: awsRawEvents.platformEventId,
    })
    .from(awsRawEvents)
    .where(whereClause)
    .orderBy(desc(awsRawEvents.receivedAt))
    .limit(limit)
    .offset((page - 1) * limit);

  const total = Number(totalRow?.total ?? 0);
  return c.json({
    data: rows,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ---------------------------------------------------------------------------
// GET /modules/aws/overview
// ---------------------------------------------------------------------------

awsRouter.get('/overview', async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const [integrationCount] = await db
    .select({ total: count() })
    .from(awsIntegrations)
    .where(eq(awsIntegrations.orgId, orgId));

  const [eventCount] = await db
    .select({ total: count() })
    .from(awsRawEvents)
    .where(eq(awsRawEvents.orgId, orgId));

  const [errorCount] = await db
    .select({ total: count() })
    .from(awsRawEvents)
    .where(and(eq(awsRawEvents.orgId, orgId), sql`error_code IS NOT NULL`));

  const integrationStatuses = await db
    .select({
      id: awsIntegrations.id,
      name: awsIntegrations.name,
      accountId: awsIntegrations.accountId,
      status: awsIntegrations.status,
      lastPolledAt: awsIntegrations.lastPolledAt,
    })
    .from(awsIntegrations)
    .where(eq(awsIntegrations.orgId, orgId))
    .orderBy(desc(awsIntegrations.createdAt))
    .limit(10);

  return c.json({
    data: {
      integrations: Number(integrationCount?.total ?? 0),
      totalEvents: Number(eventCount?.total ?? 0),
      errorEvents: Number(errorCount?.total ?? 0),
      recentIntegrations: integrationStatuses,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /modules/aws/templates
// ---------------------------------------------------------------------------

awsRouter.get('/templates', (c) => {
  return c.json({
    data: templates.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      category: t.category,
      severity: t.severity,
      ruleCount: t.rules.length,
      inputs: t.inputs ?? [],
    })),
  });
});
