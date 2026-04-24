/**
 * AWS module Hono router.
 * Manages integrations and exposes raw event data.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDb, eq, and, desc, count, sql } from '@sentinel/db';
import { awsIntegrations } from '@sentinel/db/schema/aws';
import { detections, events } from '@sentinel/db/schema/core';
import { encrypt, generateExternalId } from '@sentinel/shared/crypto';
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
      hasExternalId: sql<boolean>`(external_id IS NOT NULL)`,
      createdAt: awsIntegrations.createdAt,
    })
    .from(awsIntegrations)
    .where(eq(awsIntegrations.orgId, orgId))
    .orderBy(desc(awsIntegrations.createdAt))
    .limit(1000);

  // Distinct (integrationId, accountId) pairs seen in the events table.
  // `_integrationId` is injected into payload at ingestion time
  // (modules/aws/src/handlers.ts SQS poll loop) since the platform events
  // schema has no native column for it. accountId comes from CloudTrail's
  // `recipientAccountId` or EventBridge's `account`.
  const seenAccounts = await db.execute<{ integration_id: string | null; account_id: string | null }>(sql`
    SELECT DISTINCT
      ${events.payload}->>'_integrationId' AS integration_id,
      COALESCE(
        ${events.payload}->>'recipientAccountId',
        ${events.payload}->>'account'
      ) AS account_id
    FROM ${events}
    WHERE ${events.orgId} = ${orgId}
      AND ${events.moduleId} = 'aws'
      AND COALESCE(
        ${events.payload}->>'recipientAccountId',
        ${events.payload}->>'account'
      ) IS NOT NULL
    LIMIT 1000
  `);

  const accountsByIntegration: Record<string, string[]> = {};
  for (const row of seenAccounts as Iterable<{ integration_id: string | null; account_id: string | null }>) {
    if (!row.integration_id || !row.account_id) continue;
    if (!accountsByIntegration[row.integration_id]) accountsByIntegration[row.integration_id] = [];
    accountsByIntegration[row.integration_id].push(row.account_id);
  }

  return c.json({
    data: rows.map((r) => ({
      ...r,
      connectedAccounts: accountsByIntegration[r.id] ?? [],
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /modules/aws/integrations/init — two-step setup: step 1
// ---------------------------------------------------------------------------

const initIntegrationSchema = z.object({
  name: z.string().min(1).max(128),
  accountId: z.string().regex(/^\d{12}$/, 'AWS account ID must be 12 digits'),
  isOrgIntegration: z.boolean().default(false),
  awsOrgId: z.string().regex(/^o-[a-z0-9]{10,32}$/, 'AWS Org ID format: o-xxxxxxxxxx').optional(),
});

awsRouter.post('/integrations/init', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);
  const body = await c.req.json();
  const parsed = initIntegrationSchema.safeParse(body);
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });

  const data = parsed.data;
  const externalId = generateExternalId(orgId);
  const db = getDb();

  const [row] = await db.insert(awsIntegrations).values({
    orgId,
    name: data.name,
    accountId: data.accountId,
    isOrgIntegration: data.isOrgIntegration,
    awsOrgId: data.awsOrgId ?? null,
    externalId,
    externalIdGeneratedAt: new Date(),
    externalIdEnforced: true,
    enabled: false,
    status: 'setup',
  }).returning({
    id: awsIntegrations.id,
    name: awsIntegrations.name,
    accountId: awsIntegrations.accountId,
    externalId: awsIntegrations.externalId,
    status: awsIntegrations.status,
    createdAt: awsIntegrations.createdAt,
  });

  return c.json({ data: row }, 201);
});

// ---------------------------------------------------------------------------
// POST /modules/aws/integrations — direct creation (auto-generates external ID)
// ---------------------------------------------------------------------------

const createIntegrationSchema = z.object({
  name: z.string().min(1).max(128),
  accountId: z.string().regex(/^\d{12}$/, 'AWS account ID must be 12 digits'),
  isOrgIntegration: z.boolean().default(false),
  awsOrgId: z.string().regex(/^o-[a-z0-9]{10,32}$/, 'AWS Org ID format: o-xxxxxxxxxx').optional(),
  roleArn: z.string().startsWith('arn:aws:iam::').optional(),
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
    externalId: generateExternalId(orgId),
    externalIdGeneratedAt: new Date(),
    externalIdEnforced: true,
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
      externalId: awsIntegrations.externalId,
      externalIdEnforced: awsIntegrations.externalIdEnforced,
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
    .select({ id: awsIntegrations.id, status: awsIntegrations.status })
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

  // Finalize: transition from setup → active when configuration is provided
  if (existing.status === 'setup') {
    updates.status = 'active';
    updates.enabled = true;
  }

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
// POST /modules/aws/integrations/:id/regenerate-external-id
// ---------------------------------------------------------------------------

const regenerateSchema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: 'confirm must be true' }) }),
});

awsRouter.post('/integrations/:id/regenerate-external-id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);
  const { id } = c.req.param();
  const body = await c.req.json();
  const parsed = regenerateSchema.safeParse(body);
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });

  const db = getDb();
  const [existing] = await db
    .select({ id: awsIntegrations.id, status: awsIntegrations.status })
    .from(awsIntegrations)
    .where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)))
    .limit(1);

  if (!existing) throw new HTTPException(404, { message: 'Integration not found' });

  const newExternalId = generateExternalId(orgId);
  const newStatus = existing.status === 'setup' ? 'setup' : 'needs_update';

  await db.update(awsIntegrations).set({
    externalId: newExternalId,
    externalIdGeneratedAt: new Date(),
    externalIdEnforced: true,
    status: newStatus,
  }).where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)));

  const warning = newStatus === 'needs_update'
    ? 'External ID rotated — update your AWS trust policy with the new value, then acknowledge the rotation.'
    : undefined;

  return c.json({ data: { externalId: newExternalId, status: newStatus }, ...(warning ? { warning } : {}) });
});

// ---------------------------------------------------------------------------
// POST /modules/aws/integrations/:id/acknowledge-rotation
// ---------------------------------------------------------------------------

awsRouter.post('/integrations/:id/acknowledge-rotation', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);
  const { id } = c.req.param();

  const db = getDb();
  const [existing] = await db
    .select({ id: awsIntegrations.id, status: awsIntegrations.status })
    .from(awsIntegrations)
    .where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)))
    .limit(1);

  if (!existing) throw new HTTPException(404, { message: 'Integration not found' });
  if (existing.status !== 'needs_update') {
    throw new HTTPException(400, { message: 'Integration is not in needs_update status' });
  }

  await db.update(awsIntegrations).set({
    status: 'active',
  }).where(and(eq(awsIntegrations.id, id), eq(awsIntegrations.orgId, orgId)));

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
// GET /modules/aws/events — list AWS events from the platform events table.
// JSONB projections pull display fields out of `payload`. After the
// aws_raw_events collapse this is the only AWS event store.
// ---------------------------------------------------------------------------

awsRouter.get('/events', async (c) => {
  const orgId = c.get('orgId');
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const integrationId = c.req.query('integrationId');
  const eventNameFilter = c.req.query('eventName');
  const searchFilter = c.req.query('search');

  const db = getDb();
  const conditions = [eq(events.orgId, orgId), eq(events.moduleId, 'aws')];
  if (integrationId) {
    conditions.push(sql`${events.payload}->>'_integrationId' = ${integrationId}`);
  }
  if (eventNameFilter) {
    conditions.push(sql`${events.payload}->>'eventName' = ${eventNameFilter}`);
  }
  if (searchFilter) {
    const escaped = searchFilter.replace(/[%_\\]/g, (ch) => `\\${ch}`);
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

  const whereClause = and(...conditions);

  const [totalRow] = await db
    .select({ total: count() })
    .from(events)
    .where(whereClause);

  const rows = await db
    .select({
      id: events.id,
      integrationId: sql<string | null>`${events.payload}->>'_integrationId'`,
      cloudTrailEventId: events.externalId,
      eventName: sql<string | null>`COALESCE(${events.payload}->>'eventName', ${events.payload}->>'detail-type')`,
      eventSource: sql<string | null>`COALESCE(${events.payload}->>'eventSource', ${events.payload}->>'source')`,
      awsRegion: sql<string | null>`COALESCE(${events.payload}->>'awsRegion', ${events.payload}->>'region')`,
      principalId: sql<string | null>`${events.payload}->'userIdentity'->>'principalId'`,
      userArn: sql<string | null>`${events.payload}->'userIdentity'->>'arn'`,
      userType: sql<string | null>`${events.payload}->'userIdentity'->>'type'`,
      sourceIpAddress: sql<string | null>`${events.payload}->>'sourceIPAddress'`,
      errorCode: sql<string | null>`${events.payload}->>'errorCode'`,
      userAgent: sql<string | null>`${events.payload}->>'userAgent'`,
      eventVersion: sql<string | null>`${events.payload}->>'eventVersion'`,
      resources: sql<unknown>`${events.payload}->'resources'`,
      eventTime: events.occurredAt,
      receivedAt: events.receivedAt,
    })
    .from(events)
    .where(whereClause)
    .orderBy(desc(events.receivedAt))
    .limit(limit)
    .offset((page - 1) * limit);

  // `promoted` and `platformEventId` are vestigial from the raw-events era —
  // every row in this list is by definition a platform event. Kept in the
  // response shape so the existing UI types still match without a parallel
  // PR; the badge they drive is harmless when always-true.
  const data = rows.map((r) => ({
    ...r,
    promoted: true,
    platformEventId: r.id,
  }));

  const total = Number(totalRow?.total ?? 0);
  return c.json({
    data,
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
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.moduleId, 'aws')));

  const [errorCount] = await db
    .select({ total: count() })
    .from(events)
    .where(and(
      eq(events.orgId, orgId),
      eq(events.moduleId, 'aws'),
      sql`${events.payload}->>'errorCode' IS NOT NULL`,
    ));

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
