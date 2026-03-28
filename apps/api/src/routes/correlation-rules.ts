/**
 * Correlation rule CRUD routes.
 * Manages cross-event correlation rules (sequence, aggregation, absence).
 * Follows the same patterns as detections.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { correlationRules } from '@sentinel/db/schema/correlation';
import { auditLog } from '@sentinel/db/schema/core';
import { eq, ne, and, sql, count, desc, ilike } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg, requireRole } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';
import { correlationRuleConfigSchema } from '@sentinel/shared/correlation-types';
import type { CorrelationInstance } from '@sentinel/shared/correlation-types';
import { getSharedRedis } from '../redis.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  status: z.enum(['active', 'paused', 'deleted']).optional(),
  type: z.enum(['sequence', 'aggregation', 'absence']).optional(),
  search: z.string().max(255).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const createBodySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
  config: correlationRuleConfigSchema,
  channelIds: z.array(z.string().uuid()).default([]),
  slackChannelId: z.string().optional(),
  slackChannelName: z.string().optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(1440).default(0),
});

const updateBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  status: z.enum(['active', 'paused']).optional(),
  config: correlationRuleConfigSchema.optional(),
  channelIds: z.array(z.string().uuid()).optional(),
  slackChannelId: z.string().nullable().optional(),
  slackChannelName: z.string().nullable().optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(1440).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'At least one field must be provided' },
);

const idParamSchema = z.object({
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// POST /correlation-rules — create correlation rule
// ---------------------------------------------------------------------------

router.post('/', requireRole('admin', 'editor'), requireScope('api:write'), validate('json', createBodySchema), async (c) => {
  const body = getValidated<z.infer<typeof createBodySchema>>(c, 'json');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = getDb();

  const [rule] = await db.insert(correlationRules).values({
    orgId,
    createdBy: userId,
    name: body.name,
    description: body.description,
    severity: body.severity,
    config: body.config,
    channelIds: body.channelIds,
    slackChannelId: body.slackChannelId,
    slackChannelName: body.slackChannelName,
    cooldownMinutes: body.cooldownMinutes,
  }).returning();

  // Audit log
  await db.insert(auditLog).values({
    orgId,
    userId,
    action: 'correlation_rule.created',
    resourceType: 'correlation_rule',
    resourceId: rule.id,
    details: { name: rule.name, type: body.config.type },
  });

  return c.json({ data: rule }, 201);
});

// ---------------------------------------------------------------------------
// GET /correlation-rules — list with pagination and filters
// ---------------------------------------------------------------------------

router.get('/', requireScope('api:read'), validate('query', listQuerySchema), async (c) => {
  const query = getValidated<z.infer<typeof listQuerySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [
    eq(correlationRules.orgId, orgId),
  ];

  // Exclude soft-deleted rules by default
  if (query.status) {
    conditions.push(eq(correlationRules.status, query.status));
  } else {
    conditions.push(ne(correlationRules.status, 'deleted'));
  }

  if (query.type) {
    conditions.push(sql`${correlationRules.config}->>'type' = ${query.type}`);
  }

  if (query.search) {
    const escapedSearch = query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    conditions.push(ilike(correlationRules.name, `%${escapedSearch}%`));
  }

  const where = and(...conditions);
  const offset = (query.page - 1) * query.limit;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: correlationRules.id,
      name: correlationRules.name,
      description: correlationRules.description,
      severity: correlationRules.severity,
      status: correlationRules.status,
      config: correlationRules.config,
      channelIds: correlationRules.channelIds,
      cooldownMinutes: correlationRules.cooldownMinutes,
      lastTriggeredAt: correlationRules.lastTriggeredAt,
      createdAt: correlationRules.createdAt,
      updatedAt: correlationRules.updatedAt,
    })
      .from(correlationRules)
      .where(where)
      .orderBy(desc(correlationRules.createdAt))
      .limit(query.limit)
      .offset(offset),
    db.select({ total: count() }).from(correlationRules).where(where),
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
// GET /correlation-rules/:id — single correlation rule detail
// ---------------------------------------------------------------------------

router.get('/:id', requireScope('api:read'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  const [rule] = await db.select()
    .from(correlationRules)
    .where(and(eq(correlationRules.id, id), eq(correlationRules.orgId, orgId)))
    .limit(1);

  if (!rule || rule.status === 'deleted') {
    return c.json({ error: 'Correlation rule not found' }, 404);
  }

  return c.json({ data: rule });
});

// ---------------------------------------------------------------------------
// PATCH /correlation-rules/:id — update correlation rule
// ---------------------------------------------------------------------------

router.patch('/:id', requireRole('admin', 'editor'), requireScope('api:write'), validate('param', idParamSchema), validate('json', updateBodySchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const body = getValidated<z.infer<typeof updateBodySchema>>(c, 'json');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = getDb();

  // Verify ownership and not deleted
  const [existing] = await db.select({ status: correlationRules.status })
    .from(correlationRules)
    .where(and(eq(correlationRules.id, id), eq(correlationRules.orgId, orgId)))
    .limit(1);

  if (!existing) return c.json({ error: 'Correlation rule not found' }, 404);
  if (existing.status === 'deleted') {
    return c.json({ error: 'Cannot update a deleted correlation rule' }, 400);
  }

  // Build update set (only provided fields)
  const updateSet: Record<string, unknown> = {};
  if (body.name !== undefined) updateSet.name = body.name;
  if (body.description !== undefined) updateSet.description = body.description;
  if (body.severity !== undefined) updateSet.severity = body.severity;
  if (body.status !== undefined) updateSet.status = body.status;
  if (body.config !== undefined) updateSet.config = body.config;
  if (body.channelIds !== undefined) updateSet.channelIds = body.channelIds;
  if (body.slackChannelId !== undefined) updateSet.slackChannelId = body.slackChannelId;
  if (body.slackChannelName !== undefined) updateSet.slackChannelName = body.slackChannelName;
  if (body.cooldownMinutes !== undefined) updateSet.cooldownMinutes = body.cooldownMinutes;

  const [updated] = await db.update(correlationRules)
    .set(updateSet)
    .where(and(eq(correlationRules.id, id), eq(correlationRules.orgId, orgId)))
    .returning();

  // Audit log
  await db.insert(auditLog).values({
    orgId,
    userId,
    action: 'correlation_rule.updated',
    resourceType: 'correlation_rule',
    resourceId: id,
    details: { fields: Object.keys(updateSet) },
  });

  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// DELETE /correlation-rules/:id — soft delete (set status='deleted')
// ---------------------------------------------------------------------------

router.delete('/:id', requireRole('admin'), requireScope('api:write'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = getDb();

  // Verify the rule exists, belongs to this org, and is not already deleted
  const [existing] = await db.select({ id: correlationRules.id, name: correlationRules.name, status: correlationRules.status })
    .from(correlationRules)
    .where(and(eq(correlationRules.id, id), eq(correlationRules.orgId, orgId)))
    .limit(1);

  if (!existing) return c.json({ error: 'Correlation rule not found' }, 404);
  if (existing.status === 'deleted') return c.json({ data: { id: existing.id, name: existing.name, status: 'deleted' } });

  await db.update(correlationRules)
    .set({ status: 'deleted' })
    .where(and(eq(correlationRules.id, id), eq(correlationRules.orgId, orgId)));

  const result = existing;

  // Audit log
  await db.insert(auditLog).values({
    orgId,
    userId,
    action: 'correlation_rule.deleted',
    resourceType: 'correlation_rule',
    resourceId: id,
    details: { name: result.name },
  });

  // Clean up any active Redis instances for this rule
  try {
    const redis = getSharedRedis();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `sentinel:corr:*:${id}:*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    const reqLogger = c.get('logger');
    reqLogger.error({ err, correlationRuleId: id }, 'Failed to clean up Redis instances');
  }

  return c.json({ data: { id: result.id, name: result.name, status: 'deleted' } });
});

// ---------------------------------------------------------------------------
// GET /correlation-rules/:id/instances — list active instances from Redis
// ---------------------------------------------------------------------------

router.get('/:id/instances', requireScope('api:read'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const db = getDb();

  // Verify the rule exists and belongs to the org
  const [rule] = await db.select({ id: correlationRules.id })
    .from(correlationRules)
    .where(and(eq(correlationRules.id, id), eq(correlationRules.orgId, orgId)))
    .limit(1);

  if (!rule) return c.json({ error: 'Correlation rule not found' }, 404);

  // Scan Redis for active instances
  try {
    const redis = getSharedRedis();
    const instances: CorrelationInstance[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `sentinel:corr:*:${id}:*`, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        const pipeline = redis.pipeline();
        for (const key of keys) pipeline.get(key);
        const results = await pipeline.exec();
        for (const result of results ?? []) {
          const raw = result?.[1] as string | null;
          if (raw) {
            try {
              const instance: CorrelationInstance = JSON.parse(raw);
              if (instance.orgId === orgId) instances.push(instance);
            } catch {
              // Skip malformed entries
            }
          }
        }
      }
    } while (cursor !== '0');

    return c.json({
      data: instances,
      meta: { total: instances.length },
    });
  } catch (err) {
    const reqLogger = c.get('logger');
    reqLogger.error({ err, correlationRuleId: id }, 'Failed to fetch correlation instances from Redis');
    return c.json({ error: 'Failed to fetch active instances' }, 503);
  }
});

// ---------------------------------------------------------------------------
// DELETE /correlation-rules/:id/instances — clear all active instances
// ---------------------------------------------------------------------------

router.delete('/:id/instances', requireRole('admin', 'editor'), requireScope('api:write'), validate('param', idParamSchema), async (c) => {
  const { id } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = getDb();

  // Verify the rule exists and belongs to the org
  const [rule] = await db.select({ id: correlationRules.id })
    .from(correlationRules)
    .where(and(eq(correlationRules.id, id), eq(correlationRules.orgId, orgId)))
    .limit(1);

  if (!rule) return c.json({ error: 'Correlation rule not found' }, 404);

  // Scan and delete Redis instances
  try {
    const redis = getSharedRedis();
    let cursor = '0';
    let deletedCount = 0;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `sentinel:corr:*:${id}:*`, 'COUNT', 100);
      cursor = nextCursor;

      // Fetch all key values in one pipeline, then delete in bulk
      if (keys.length > 0) {
        const pipeline = redis.pipeline();
        for (const key of keys) {
          pipeline.get(key);
        }
        const results = await pipeline.exec();

        const keysToDelete: string[] = [];
        if (results) {
          for (let i = 0; i < keys.length; i++) {
            const [err, raw] = results[i] as [Error | null, string | null];
            if (err || !raw) continue;
            try {
              const instance: CorrelationInstance = JSON.parse(raw);
              if (instance.orgId === orgId) {
                keysToDelete.push(keys[i]);
              }
            } catch {
              // Skip malformed entries
            }
          }
        }

        if (keysToDelete.length > 0) {
          await redis.del(...keysToDelete);
          deletedCount += keysToDelete.length;
        }
      }
    } while (cursor !== '0');

    // Audit log
    await db.insert(auditLog).values({
      orgId,
      userId,
      action: 'correlation_rule.instances_cleared',
      resourceType: 'correlation_rule',
      resourceId: id,
      details: { deletedCount },
    });

    return c.json({ data: { deletedCount } });
  } catch (err) {
    const reqLogger = c.get('logger');
    reqLogger.error({ err, correlationRuleId: id }, 'Failed to clear correlation instances from Redis');
    return c.json({ error: 'Failed to clear active instances' }, 503);
  }
});

export { router as correlationRulesRouter };
