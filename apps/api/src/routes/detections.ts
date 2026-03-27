/**
 * Detection CRUD routes.
 * Detections are created from module templates, contain rules that get evaluated against events.
 * Ported from ChainAlert's detection patterns adapted for multi-module platform.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { detections, rules } from '@sentinel/db/schema/core';
import { eq, and, sql, count, desc, asc, ilike } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg, requireRole } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  moduleId: z.string().optional(),
  status: z.enum(['active', 'paused', 'error', 'disabled']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  search: z.string().max(255).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const createBodySchema = z.object({
  moduleId: z.string().min(1),
  templateSlug: z.string().min(1).optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
  channelIds: z.array(z.string().uuid()).default([]),
  slackChannelId: z.string().optional(),
  slackChannelName: z.string().optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(1440).default(0),
  config: z.record(z.string(), z.unknown()).default({}),
  rules: z.array(z.object({
    ruleType: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    action: z.enum(['alert', 'log', 'suppress']).default('alert'),
    priority: z.coerce.number().int().min(0).max(100).default(50),
  })).min(1),
});

const updateBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  channelIds: z.array(z.string().uuid()).optional(),
  slackChannelId: z.string().nullable().optional(),
  slackChannelName: z.string().nullable().optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  rules: z.array(z.object({
    ruleType: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    action: z.enum(['alert', 'log', 'suppress']).default('alert'),
    priority: z.coerce.number().int().min(0).max(100).default(50),
  })).min(1).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'At least one field must be provided' },
);

const idParamSchema = z.object({
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// POST /detections — create detection with rules
// ---------------------------------------------------------------------------

router.post('/', requireRole('admin', 'editor'), requireScope('api:write'), validate('json', createBodySchema), async (c) => {
  const body = getValidated<z.infer<typeof createBodySchema>>(c, 'json');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = getDb();

  const result = await db.transaction(async (tx) => {
    const [detection] = await tx.insert(detections).values({
      orgId,
      createdBy: userId,
      moduleId: body.moduleId,
      templateId: body.templateSlug,
      name: body.name,
      description: body.description,
      severity: body.severity,
      channelIds: body.channelIds,
      slackChannelId: body.slackChannelId,
      slackChannelName: body.slackChannelName,
      cooldownMinutes: body.cooldownMinutes,
      config: body.config,
    }).returning();

    const ruleRows = await tx.insert(rules).values(
      body.rules.map((r) => ({
        detectionId: detection.id,
        orgId,
        moduleId: body.moduleId,
        ruleType: r.ruleType,
        config: r.config,
        action: r.action,
        priority: r.priority,
      })),
    ).returning();

    return { detection, rules: ruleRows };
  });

  return c.json({ data: result }, 201);
});

// ---------------------------------------------------------------------------
// GET /detections — list with pagination and filters
// ---------------------------------------------------------------------------

router.get('/', requireScope('api:read'), validate('query', listQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof listQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(detections.orgId, orgId)];
  if (query.moduleId) conditions.push(eq(detections.moduleId, query.moduleId));
  if (query.status) conditions.push(eq(detections.status, query.status));
  if (query.severity) conditions.push(eq(detections.severity, query.severity));
  if (query.search) {
    // Escape LIKE special characters to prevent pattern injection
    const escapedSearch = query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    conditions.push(ilike(detections.name, `%${escapedSearch}%`));
  }

  const where = and(...conditions);
  const offset = (query.page - 1) * query.limit;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: detections.id,
      moduleId: detections.moduleId,
      templateId: detections.templateId,
      name: detections.name,
      description: detections.description,
      severity: detections.severity,
      status: detections.status,
      cooldownMinutes: detections.cooldownMinutes,
      lastTriggeredAt: detections.lastTriggeredAt,
      createdAt: detections.createdAt,
      updatedAt: detections.updatedAt,
      ruleCount: sql<number>`(
        SELECT count(*)::int FROM rules
        WHERE rules.detection_id = ${detections.id}
          AND rules.status != 'disabled'
      )`.as('rule_count'),
    })
      .from(detections)
      .where(where)
      .orderBy(desc(detections.createdAt))
      .limit(query.limit)
      .offset(offset),
    db.select({ total: count() }).from(detections).where(where),
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
// GET /detections/:id — single detection with rules
// ---------------------------------------------------------------------------

router.get('/:id', requireScope('api:read'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const [detection] = await db.select()
    .from(detections)
    .where(and(eq(detections.id, id), eq(detections.orgId, orgId)))
    .limit(1);

  if (!detection) return c.json({ error: 'Detection not found' }, 404);

  const detectionRules = await db.select()
    .from(rules)
    .where(eq(rules.detectionId, id))
    .orderBy(asc(rules.priority));

  return c.json({ data: { ...detection, rules: detectionRules } });
});

// ---------------------------------------------------------------------------
// PATCH /detections/:id — update detection
// ---------------------------------------------------------------------------

router.patch('/:id', requireRole('admin', 'editor'), requireScope('api:write'), validate('param', idParamSchema), validate('json', updateBodySchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const body = getValidated<z.infer<typeof updateBodySchema>>(c, 'json');
  const orgId = c.get('orgId');
  const db = getDb();

  // Verify ownership and not archived
  const [existing] = await db.select({ status: detections.status, moduleId: detections.moduleId })
    .from(detections)
    .where(and(eq(detections.id, id), eq(detections.orgId, orgId)))
    .limit(1);

  if (!existing) return c.json({ error: 'Detection not found' }, 404);
  if (existing.status === 'disabled') {
    return c.json({ error: 'Cannot update an archived detection' }, 400);
  }

  // Build update set (only provided fields)
  const updateSet: Record<string, unknown> = {};
  if (body.name !== undefined) updateSet.name = body.name;
  if (body.description !== undefined) updateSet.description = body.description;
  if (body.severity !== undefined) updateSet.severity = body.severity;
  if (body.channelIds !== undefined) updateSet.channelIds = body.channelIds;
  if (body.slackChannelId !== undefined) updateSet.slackChannelId = body.slackChannelId;
  if (body.slackChannelName !== undefined) updateSet.slackChannelName = body.slackChannelName;
  if (body.cooldownMinutes !== undefined) updateSet.cooldownMinutes = body.cooldownMinutes;
  if (body.config !== undefined) updateSet.config = body.config;

  // Handle status transitions
  if (body.status !== undefined) {
    updateSet.status = body.status;

    // Pausing detection pauses its rules; activating reactivates them
    const ruleStatus = body.status === 'paused' ? 'paused' : 'active';
    await db.update(rules)
      .set({ status: ruleStatus })
      .where(eq(rules.detectionId, id));
  }

  // Replace rules if provided (delete existing, insert new)
  if (body.rules !== undefined) {
    await db.transaction(async (tx) => {
      await tx.delete(rules).where(eq(rules.detectionId, id));
      await tx.insert(rules).values(
        body.rules!.map((r) => ({
          detectionId: id,
          orgId,
          moduleId: existing.moduleId,
          ruleType: r.ruleType,
          config: r.config,
          action: r.action,
          priority: r.priority,
        })),
      );
    });
  }

  const [updated] = await db.update(detections)
    .set(updateSet)
    .where(and(eq(detections.id, id), eq(detections.orgId, orgId)))
    .returning();

  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// DELETE /detections/:id — archive (soft delete)
// ---------------------------------------------------------------------------

router.delete('/:id', requireRole('admin'), requireScope('api:write'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const result = await db.transaction(async (tx) => {
    // Verify ownership FIRST — before touching any rules
    const [detection] = await tx.update(detections)
      .set({ status: 'disabled' })
      .where(and(eq(detections.id, id), eq(detections.orgId, orgId)))
      .returning({ id: detections.id, name: detections.name });

    if (!detection) return undefined;

    // Only disable rules after confirming the detection belongs to this org.
    // Include orgId in the WHERE clause for defense-in-depth.
    await tx.update(rules)
      .set({ status: 'disabled' })
      .where(and(eq(rules.detectionId, id), eq(rules.orgId, orgId)));

    return detection;
  });

  if (!result) return c.json({ error: 'Detection not found' }, 404);
  return c.json({ data: { id: result.id, name: result.name, status: 'disabled' } });
});

// ---------------------------------------------------------------------------
// POST /detections/from-template — create detection from a module template
// ---------------------------------------------------------------------------

const fromTemplateSchema = z.object({
  moduleId: z.string().min(1),
  templateSlug: z.string().min(1),
  name: z.string().min(1).max(255).optional(),
  channelIds: z.array(z.string().uuid()).default([]),
  slackChannelId: z.string().optional(),
  slackChannelName: z.string().optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(1440).default(5),
  overrides: z.record(z.string(), z.unknown()).default({}),
});

router.post('/from-template', requireRole('admin', 'editor'), requireScope('api:write'), validate('json', fromTemplateSchema), async (c) => {
  const body = getValidated<z.infer<typeof fromTemplateSchema>>(c, 'json');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = getDb();

  // Import all modules to search their templates
  const { GitHubModule } = await import('@sentinel/module-github');
  const { ReleaseChainModule } = await import('@sentinel/module-release-chain');
  const { ChainModule } = await import('@sentinel/module-chain');
  const { InfraModule } = await import('@sentinel/module-infra');
  const modules = [GitHubModule, ReleaseChainModule, ChainModule, InfraModule];

  const mod = modules.find((m) => m.id === body.moduleId);
  if (!mod) return c.json({ error: `Module "${body.moduleId}" not found` }, 404);

  const template = mod.templates.find((t) => t.slug === body.templateSlug);
  if (!template) return c.json({ error: `Template "${body.templateSlug}" not found` }, 404);

  const detectionName = body.name ?? template.name;

  const result = await db.transaction(async (tx) => {
    const [detection] = await tx.insert(detections).values({
      orgId,
      createdBy: userId,
      moduleId: body.moduleId,
      templateId: template.slug,
      name: detectionName,
      description: template.description,
      severity: template.severity,
      channelIds: body.channelIds,
      slackChannelId: body.slackChannelId,
      slackChannelName: body.slackChannelName,
      cooldownMinutes: body.cooldownMinutes,
      config: body.overrides,
    }).returning();

    const ruleRows = await tx.insert(rules).values(
      template.rules.map((r) => ({
        detectionId: detection.id,
        orgId,
        moduleId: body.moduleId,
        ruleType: r.ruleType,
        config: { ...r.config, ...body.overrides },
        action: r.action,
        priority: r.priority ?? 50,
      })),
    ).returning();

    return { detection, rules: ruleRows };
  });

  return c.json({ data: result }, 201);
});

// ---------------------------------------------------------------------------
// POST /detections/:id/test — dry-run a detection against a test event
// ---------------------------------------------------------------------------

const testBodySchema = z.object({
  eventId: z.string().uuid().optional(),
  event: z.object({
    eventType: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }).optional(),
}).refine((d) => d.eventId || d.event, { message: 'Provide either eventId or event' });

router.post('/:id/test', requireScope('api:read'), async (c) => {
  const orgId = c.get('orgId')!;
  const detectionId = c.req.param('id')!;
  const db = getDb();

  // Validate detection exists and belongs to org
  const [detection] = await db
    .select()
    .from(detections)
    .where(and(eq(detections.id, detectionId), eq(detections.orgId, orgId)))
    .limit(1);

  if (!detection) return c.json({ error: 'Detection not found' }, 404);

  const body = await c.req.json();
  const parsed = testBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  // Build the normalized event
  let normalizedEvent;

  if (parsed.data.eventId) {
    // Load existing event from DB
    const { events } = await import('@sentinel/db/schema/core');
    const [existingEvent] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, parsed.data.eventId), eq(events.orgId, orgId)))
      .limit(1);

    if (!existingEvent) return c.json({ error: 'Event not found' }, 404);

    normalizedEvent = {
      id: existingEvent.id,
      orgId: existingEvent.orgId,
      moduleId: existingEvent.moduleId,
      eventType: existingEvent.eventType,
      externalId: existingEvent.externalId,
      payload: existingEvent.payload as Record<string, unknown>,
      occurredAt: existingEvent.occurredAt ?? new Date(),
      receivedAt: existingEvent.receivedAt ?? new Date(),
    };
  } else {
    const ev = parsed.data.event!;
    normalizedEvent = {
      id: crypto.randomUUID(),
      orgId,
      moduleId: detection.moduleId,
      eventType: ev.eventType,
      externalId: null,
      payload: ev.payload,
      occurredAt: new Date(),
      receivedAt: new Date(),
    };
  }

  // Build evaluator registry
  const { GitHubModule } = await import('@sentinel/module-github');
  const { ReleaseChainModule } = await import('@sentinel/module-release-chain');
  const { ChainModule } = await import('@sentinel/module-chain');
  const { InfraModule } = await import('@sentinel/module-infra');
  const { compoundEvaluator } = await import('@sentinel/shared/evaluators/compound');
  const modules = [GitHubModule, ReleaseChainModule, ChainModule, InfraModule];

  const { RuleEngine } = await import('@sentinel/shared/rule-engine');
  const { default: IORedis } = await import('ioredis');
  const { env } = await import('@sentinel/shared/env');

  const evaluators = new Map();
  for (const mod of modules) {
    for (const evaluator of mod.evaluators) {
      evaluators.set(`${evaluator.moduleId}:${evaluator.ruleType}`, evaluator);
    }
  }
  evaluators.set(`${compoundEvaluator.moduleId}:${compoundEvaluator.ruleType}`, compoundEvaluator);

  const redis = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

  try {
    const engine = new RuleEngine({ evaluators, redis, db });
    const result = await engine.evaluateDryRun(normalizedEvent, detectionId);

    return c.json({
      data: {
        wouldTrigger: result.candidates.length > 0,
        suppressed: result.suppressed,
        candidates: result.candidates,
        rulesEvaluated: result.alertedDetectionIds.size + (result.suppressed ? 1 : 0),
      },
    });
  } finally {
    await redis.quit();
  }
});

export { router as detectionsRouter };
