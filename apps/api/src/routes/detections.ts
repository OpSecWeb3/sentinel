/**
 * Detection CRUD routes.
 * Detections are created from module templates, contain rules that get evaluated against events.
 * Ported from ChainAlert's detection patterns adapted for multi-module platform.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { detections, rules } from '@sentinel/db/schema/core';
import { eq, and, sql, count, desc, asc, ilike, inArray, ne } from '@sentinel/db';
import type { AppEnv } from '@sentinel/shared/hono-types';
import type { DetectionTemplate, TemplateInput } from '@sentinel/shared/module';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import { requireAuth, requireOrg, requireRole } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';
import { logger as rootLogger } from '@sentinel/shared/logger';

const log = rootLogger.child({ component: 'detections-router' });

// ---------------------------------------------------------------------------
// Rule sync: notify module poll systems when rules change
// ---------------------------------------------------------------------------

const MODULES_WITH_RULE_SYNC = new Set(['chain']);

async function syncRulesToModule(
  action: 'add' | 'update' | 'remove' | 'reconcile',
  moduleId: string,
  ruleRows: Array<{ id: string; ruleType: string; config: unknown }>,
) {
  if (!MODULES_WITH_RULE_SYNC.has(moduleId)) return;

  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  for (const rule of ruleRows) {
    try {
      await queue.add('chain.rule.sync', {
        action,
        ruleId: rule.id,
        config: { ...rule.config as Record<string, unknown>, ruleType: rule.ruleType },
      }, { jobId: `rule-sync-${rule.id}-${Date.now()}` });
    } catch (err) {
      log.error({ err, ruleId: rule.id, action }, 'Failed to enqueue rule sync');
    }
  }
}

// ---------------------------------------------------------------------------
// Prerequisite validation: ensure upstream resources exist before creating
// detections. Without these, rules evaluate against events that never arrive.
// ---------------------------------------------------------------------------

import { infraHosts, infraScanSchedules } from '@sentinel/db/schema/infra';
import { rcArtifacts } from '@sentinel/db/schema/registry';
import { awsIntegrations } from '@sentinel/db/schema/aws';
import { githubInstallations } from '@sentinel/db/schema/github';
import { chainContracts, chainNetworks } from '@sentinel/db/schema/chain';

interface PrereqResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

async function validatePrerequisites(
  moduleId: string,
  orgId: string,
  config: Record<string, unknown>,
  ruleConfigs: Array<Record<string, unknown>>,
): Promise<PrereqResult> {
  const db = getDb();
  const warnings: string[] = [];

  if (moduleId === 'infra') {
    // Infra detections need at least one active host with a scan schedule
    const hosts = await db.select({ id: infraHosts.id })
      .from(infraHosts)
      .innerJoin(infraScanSchedules, eq(infraScanSchedules.hostId, infraHosts.id))
      .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.isActive, true), eq(infraScanSchedules.enabled, true)))
      .limit(1);

    if (hosts.length === 0) {
      return { ok: false, error: 'No active hosts with scanning enabled. Add a host at /infra/hosts before creating infra detections.' };
    }
  }

  if (moduleId === 'registry') {
    // Registry detections need at least one monitored artifact
    const artifactName = config.artifactName as string | undefined;
    if (artifactName) {
      const [artifact] = await db.select({ id: rcArtifacts.id, enabled: rcArtifacts.enabled })
        .from(rcArtifacts)
        .where(and(eq(rcArtifacts.orgId, orgId), eq(rcArtifacts.name, artifactName)))
        .limit(1);

      if (!artifact) {
        return { ok: false, error: `Artifact "${artifactName}" is not registered for monitoring. Add it at /registry/images or /registry/packages first.` };
      }
      if (!artifact.enabled) {
        warnings.push(`Artifact "${artifactName}" exists but is disabled. Enable it to receive events.`);
      }
    } else {
      // No specific artifact — check org has at least one
      const artifacts = await db.select({ id: rcArtifacts.id })
        .from(rcArtifacts)
        .where(and(eq(rcArtifacts.orgId, orgId), eq(rcArtifacts.enabled, true)))
        .limit(1);

      if (artifacts.length === 0) {
        return { ok: false, error: 'No monitored images or packages found. Add an artifact at /registry/images or /registry/packages before creating registry detections.' };
      }
    }
  }

  if (moduleId === 'aws') {
    const integrations = await db.select({ id: awsIntegrations.id })
      .from(awsIntegrations)
      .where(and(eq(awsIntegrations.orgId, orgId), eq(awsIntegrations.enabled, true), eq(awsIntegrations.status, 'active')))
      .limit(1);

    if (integrations.length === 0) {
      return { ok: false, error: 'No active AWS integrations found. Connect an AWS account at /aws/integrations before creating AWS detections.' };
    }
  }

  if (moduleId === 'github') {
    const installations = await db.select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.status, 'active')))
      .limit(1);

    if (installations.length === 0) {
      return { ok: false, error: 'No active GitHub App installations found. Install the GitHub App at /github/installations before creating GitHub detections.' };
    }
  }

  if (moduleId === 'chain') {
    // Chain needs a valid network, and contract if referenced
    const networkId = config.networkId as number | undefined;
    if (networkId) {
      const [network] = await db.select({ id: chainNetworks.id })
        .from(chainNetworks)
        .where(eq(chainNetworks.chainId, networkId))
        .limit(1);

      if (!network) {
        return { ok: false, error: `Network with chain ID ${networkId} not found. Add the network at /chain/networks first.` };
      }
    }

    const contractAddress = (config.contractAddress as string) ?? ruleConfigs.find((r) => r.contractAddress)?.contractAddress as string | undefined;
    if (!contractAddress) {
      return { ok: false, error: 'Contract address is required for chain detections.' };
    }

    const contractId = (config.contractId as number) ?? ruleConfigs.find((r) => r.contractId)?.contractId as number | undefined;

    if (contractId) {
      const [contract] = await db.select({ id: chainContracts.id })
        .from(chainContracts)
        .where(eq(chainContracts.id, contractId))
        .limit(1);

      if (!contract) {
        return { ok: false, error: `Contract ID ${contractId} not found. Register the contract at /chain/contracts first.` };
      }
    }
  }

  return { ok: true, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * For chain rules, resolve networkId (chainId) → networkSlug and inject it
 * into rule configs so loaders can filter by either field.
 */
async function injectNetworkSlugIntoChainConfigs(
  moduleId: string,
  configs: Record<string, unknown>[],
): Promise<void> {
  if (moduleId !== 'chain') return;
  const networkId = configs.find(c => c.networkId !== undefined)?.networkId;
  if (!networkId) return;
  const db = getDb();
  const [network] = await db
    .select({ slug: chainNetworks.slug })
    .from(chainNetworks)
    .where(eq(chainNetworks.chainId, Number(networkId)))
    .limit(1);
  if (!network) return;
  for (const c of configs) {
    if (!c.networkSlug) c.networkSlug = network.slug;
  }
}

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
  /** Template-based update: re-derive rules from template + new inputs */
  templateSlug: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
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

  // Validate upstream resources exist before creating detection
  const prereq = await validatePrerequisites(
    body.moduleId, orgId, body.config, body.rules.map((r) => r.config),
  );
  if (!prereq.ok) return c.json({ error: prereq.error }, 400);

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
      config: Object.keys(body.config).length > 0
        ? body.config
        : body.rules.reduce<Record<string, unknown>>((acc, r) => ({ ...acc, ...r.config }), {}),
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

  // Notify module poll systems about new rules
  await syncRulesToModule('add', body.moduleId, result.rules);

  return c.json({ data: result, ...(prereq.warnings ? { warnings: prereq.warnings } : {}) }, 201);
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
    })
      .from(detections)
      .where(where)
      .orderBy(desc(detections.createdAt))
      .limit(query.limit)
      .offset(offset),
    db.select({ total: count() }).from(detections).where(where),
  ]);

  const detectionIds = rows.map((r) => r.id);
  let ruleCountMap = new Map<string, number>();
  if (detectionIds.length > 0) {
    const ruleCounts = await db
      .select({ detectionId: rules.detectionId, total: count() })
      .from(rules)
      .where(and(
        inArray(rules.detectionId, detectionIds),
        ne(rules.status, 'disabled'),
      ))
      .groupBy(rules.detectionId);
    ruleCountMap = new Map(ruleCounts.map((r) => [r.detectionId, Number(r.total)]));
  }

  return c.json({
    data: rows.map((r) => ({ ...r, ruleCount: ruleCountMap.get(r.id) ?? 0 })),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /detections/resolve-template — return a template definition by moduleId + slug
// Must be defined BEFORE /:id to prevent "resolve-template" matching as a UUID param.
// ---------------------------------------------------------------------------

const resolveTemplateQuerySchema = z.object({
  moduleId: z.string().min(1),
  slug: z.string().min(1),
});

router.get('/resolve-template', requireScope('api:read'), validate('query', resolveTemplateQuerySchema), async (c) => {
  const { moduleId, slug } = getValidated<z.infer<typeof resolveTemplateQuerySchema>>(c, 'query');

  const { GitHubModule } = await import('@sentinel/module-github');
  const { RegistryModule } = await import('@sentinel/module-registry');
  const { ChainModule } = await import('@sentinel/module-chain');
  const { InfraModule } = await import('@sentinel/module-infra');
  const { AwsModule } = await import('@sentinel/module-aws');
  const modules = [GitHubModule, RegistryModule, ChainModule, InfraModule, AwsModule];

  const mod = modules.find((m) => m.id === moduleId);
  if (!mod) return c.json({ error: `Module "${moduleId}" not found` }, 404);

  const template = mod.templates.find((t) => t.slug === slug);
  if (!template) return c.json({ error: `Template "${slug}" not found` }, 404);

  return c.json({ data: { template } });
});

// ---------------------------------------------------------------------------
// GET /detections/rule-schema — return uiSchema for a given ruleType
// Must be defined BEFORE /:id to prevent "rule-schema" matching as a UUID param.
// ---------------------------------------------------------------------------

const ruleSchemaQuerySchema = z.object({
  ruleType: z.string().min(1),
});

router.get('/rule-schema', requireScope('api:read'), validate('query', ruleSchemaQuerySchema), async (c) => {
  const { ruleType } = getValidated<z.infer<typeof ruleSchemaQuerySchema>>(c, 'query');

  const { GitHubModule } = await import('@sentinel/module-github');
  const { RegistryModule } = await import('@sentinel/module-registry');
  const { ChainModule } = await import('@sentinel/module-chain');
  const { InfraModule } = await import('@sentinel/module-infra');
  const { AwsModule } = await import('@sentinel/module-aws');
  const modules = [GitHubModule, RegistryModule, ChainModule, InfraModule, AwsModule];

  for (const mod of modules) {
    const evaluator = mod.evaluators.find((e) => e.ruleType === ruleType);
    if (evaluator) {
      return c.json({ data: { uiSchema: evaluator.uiSchema ?? [] } });
    }
  }

  // Unknown rule type — return empty schema (graceful degradation)
  return c.json({ data: { uiSchema: [] } });
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

    // Pausing detection pauses its rules; activating reactivates them.
    const ruleStatus = body.status === 'paused' ? 'paused' : 'active';
    await db.update(rules)
      .set({ status: ruleStatus })
      .where(and(eq(rules.detectionId, id), eq(rules.orgId, orgId)));

    // Notify module poll systems: pause removes schedules, activate re-adds them
    const affectedRules = await db.select({ id: rules.id, ruleType: rules.ruleType, config: rules.config })
      .from(rules)
      .where(and(eq(rules.detectionId, id), eq(rules.orgId, orgId)));
    const action = body.status === 'paused' ? 'remove' : 'add';
    await syncRulesToModule(action as 'add' | 'remove', existing.moduleId, affectedRules);
  }

  // Replace rules if provided (delete existing, insert new).
  // The detection update is included inside the same transaction so that a
  // failure during the detection write cannot leave the DB with new rules
  // paired to the old detection record (inconsistent state).
  if (body.rules !== undefined) {
    // Keep detection.config in sync with the merged rule configs so the
    // detail and edit pages reflect the current values.
    const mergedConfig = body.rules.reduce<Record<string, unknown>>(
      (acc, r) => ({ ...acc, ...r.config }),
      {},
    );
    updateSet.config = mergedConfig;

    // Remove old rules' poll schedules before replacing
    const oldRules = await db.select({ id: rules.id, ruleType: rules.ruleType, config: rules.config })
      .from(rules)
      .where(and(eq(rules.detectionId, id), eq(rules.orgId, orgId)));
    await syncRulesToModule('remove', existing.moduleId, oldRules);

    let newRuleRows: Array<{ id: string; ruleType: string; config: unknown }> = [];
    const [updated] = await db.transaction(async (tx) => {
      await tx.delete(rules).where(and(eq(rules.detectionId, id), eq(rules.orgId, orgId)));
      newRuleRows = await tx.insert(rules).values(
        body.rules!.map((r) => ({
          detectionId: id,
          orgId,
          moduleId: existing.moduleId,
          ruleType: r.ruleType,
          config: r.config,
          action: r.action,
          priority: r.priority,
        })),
      ).returning();
      return tx.update(detections)
        .set(updateSet)
        .where(and(eq(detections.id, id), eq(detections.orgId, orgId)))
        .returning();
    });

    // Sync new rules to module poll systems
    await syncRulesToModule('add', existing.moduleId, newRuleRows);

    return c.json({ data: updated });
  }

  // Template-based rule rebuild: resolve template, apply inputs, replace rules.
  // Same atomicity requirement — detection update is inside the transaction.
  if (body.templateSlug !== undefined) {
    const { GitHubModule } = await import('@sentinel/module-github');
    const { RegistryModule } = await import('@sentinel/module-registry');
    const { ChainModule } = await import('@sentinel/module-chain');
    const { InfraModule } = await import('@sentinel/module-infra');
    const { AwsModule } = await import('@sentinel/module-aws');
    const modules = [GitHubModule, RegistryModule, ChainModule, InfraModule, AwsModule];

    const mod = modules.find((m) => m.id === existing.moduleId);
    if (!mod) return c.json({ error: `Module "${existing.moduleId}" not found` }, 400);

    const template = mod.templates.find((t) => t.slug === body.templateSlug);
    if (!template) return c.json({ error: `Template "${body.templateSlug}" not found` }, 400);

    const inputsMap = buildEffectiveTemplateInputs(template, body.inputs ?? {});
    const patchBuiltConfigs = template.rules.map((r) => applyTemplateInputs(r.config, inputsMap));
    finalizeTemplateRuleConfigs(patchBuiltConfigs);
    await injectNetworkSlugIntoChainConfigs(existing.moduleId, patchBuiltConfigs);
    const patchUnresolved = filterUnresolvedForTemplate(findUnresolvedPlaceholders(patchBuiltConfigs), template);
    if (patchUnresolved.length > 0) {
      return c.json({ error: `Missing required inputs: ${patchUnresolved.join(', ')}` }, 400);
    }

    // Keep config in sync so the edit page can pre-fill on next load
    updateSet.config = { ...inputsMap, ...(body.overrides ?? {}) };

    // Remove old rules' poll schedules before replacing
    const oldRules = await db.select({ id: rules.id, ruleType: rules.ruleType, config: rules.config })
      .from(rules)
      .where(and(eq(rules.detectionId, id), eq(rules.orgId, orgId)));
    await syncRulesToModule('remove', existing.moduleId, oldRules);

    let newRuleRows: Array<{ id: string; ruleType: string; config: unknown }> = [];
    const [updated] = await db.transaction(async (tx) => {
      await tx.delete(rules).where(and(eq(rules.detectionId, id), eq(rules.orgId, orgId)));
      newRuleRows = await tx.insert(rules).values(
        template.rules.map((r, i) => ({
          detectionId: id,
          orgId,
          moduleId: existing.moduleId,
          ruleType: r.ruleType,
          config: patchBuiltConfigs[i],
          action: r.action,
          priority: r.priority ?? 50,
        })),
      ).returning();
      return tx.update(detections)
        .set(updateSet)
        .where(and(eq(detections.id, id), eq(detections.orgId, orgId)))
        .returning();
    });

    // Sync new rules to module poll systems
    await syncRulesToModule('add', existing.moduleId, newRuleRows);

    return c.json({ data: updated });
  }

  // No rule replacement — plain field or status-only update.
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

  // Load the detection's moduleId and rules BEFORE disabling, so we can notify the module
  const [existing] = await db.select({ moduleId: detections.moduleId })
    .from(detections)
    .where(and(eq(detections.id, id), eq(detections.orgId, orgId)))
    .limit(1);

  const existingRules = existing
    ? await db.select({ id: rules.id, ruleType: rules.ruleType, config: rules.config })
        .from(rules)
        .where(and(eq(rules.detectionId, id), eq(rules.orgId, orgId)))
    : [];

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

  // Notify module to remove poll schedules for disabled rules
  if (existing && existingRules.length > 0) {
    await syncRulesToModule('remove', existing.moduleId, existingRules);
  }

  return c.json({ data: { id: result.id, name: result.name, status: 'disabled' } });
});

// ---------------------------------------------------------------------------
// POST /detections/from-template — create detection from a module template
// ---------------------------------------------------------------------------

const STRINGISH_TEMPLATE_INPUT_TYPES = new Set<TemplateInput['type']>(['text', 'address', 'select', 'string-array']);

/**
 * Merge template input defaults and substitute omitted optional string fields with ""
 * so {{placeholders}} resolve instead of staying in stored rule configs.
 */
function buildEffectiveTemplateInputs(
  template: DetectionTemplate,
  bodyInputs: Record<string, unknown>,
): Record<string, unknown> {
  const defs = template.inputs ?? [];
  const out: Record<string, unknown> = {};

  for (const inp of defs) {
    if (inp.default !== undefined) {
      out[inp.key] = inp.default;
    }
  }
  for (const [k, v] of Object.entries(bodyInputs)) {
    out[k] = v;
  }
  for (const inp of defs) {
    if (inp.required) continue;
    if (inp.default !== undefined) continue;
    if (Object.prototype.hasOwnProperty.call(bodyInputs, inp.key)) continue;
    if (STRINGISH_TEMPLATE_INPUT_TYPES.has(inp.type) && !(inp.key in out)) {
      out[inp.key] = '';
    }
  }
  return out;
}

/** Unresolved {{tokens}} that are optional template inputs are allowed (safety net for non-string optionals). */
function filterUnresolvedForTemplate(unresolved: string[], template: DetectionTemplate): string[] {
  const optional = new Set((template.inputs ?? []).filter((i) => !i.required).map((i) => i.key));
  return unresolved.filter((k) => !optional.has(k));
}

/** Drop arg-filter conditions with an empty field (optional filters from templates). */
function pruneEmptyConditionsInConfig(config: Record<string, unknown>) {
  const conds = config.conditions;
  if (!Array.isArray(conds)) return;
  const filtered = conds.filter((c) => {
    if (!c || typeof c !== 'object') return true;
    const field = (c as Record<string, unknown>).field;
    if (typeof field !== 'string') return true;
    return field.trim() !== '';
  });
  if (filtered.length === 0) {
    delete config.conditions;
  } else {
    config.conditions = filtered;
  }
}

function finalizeTemplateRuleConfigs(configs: Record<string, unknown>[]) {
  for (const c of configs) {
    pruneEmptyConditionsInConfig(c);
  }
}

/**
 * Deep-interpolate {{key}} placeholders in a config object using user inputs.
 * A token that is the ENTIRE string value (e.g. "{{threshold}}") is replaced
 * with the typed value from inputs. Partial replacements stay as strings.
 * After interpolation, all inputs are merged in as direct config overrides.
 */
function applyTemplateInputs(
  config: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  function interpolate(val: unknown): unknown {
    if (typeof val === 'string') {
      const full = val.match(/^\{\{(\w+)\}\}$/);
      if (full) return inputs[full[1]] ?? val;
      return val.replace(/\{\{(\w+)\}\}/g, (_, k) =>
        inputs[k] !== undefined ? String(inputs[k]) : `{{${k}}}`,
      );
    }
    if (Array.isArray(val)) return val.map(interpolate);
    if (val && typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, interpolate(v)]),
      );
    }
    return val;
  }
  return { ...(interpolate(config) as Record<string, unknown>), ...inputs };
}

/**
 * Scan all rule configs for remaining {{key}} tokens left after interpolation.
 * Returns a deduplicated list of unresolved token names.
 */
function findUnresolvedPlaceholders(configs: Record<string, unknown>[]): string[] {
  const found: string[] = [];
  function scan(val: unknown) {
    if (typeof val === 'string') {
      let m: RegExpExecArray | null;
      const re = /\{\{(\w+)\}\}/g;
      while ((m = re.exec(val)) !== null) found.push(m[1]);
    } else if (Array.isArray(val)) {
      val.forEach(scan);
    } else if (val && typeof val === 'object') {
      Object.values(val as object).forEach(scan);
    }
  }
  configs.forEach((c) => scan(c));
  return [...new Set(found)];
}

const fromTemplateSchema = z.object({
  moduleId: z.string().min(1),
  templateSlug: z.string().min(1),
  name: z.string().min(1).max(255).optional(),
  channelIds: z.array(z.string().uuid()).default([]),
  slackChannelId: z.string().optional(),
  slackChannelName: z.string().optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(1440).default(5),
  /** Template form inputs — replace {{placeholders}} and merge into rule configs */
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Detection-level config overrides (e.g. hostIds for infra, artifactName for registry) */
  overrides: z.record(z.string(), z.unknown()).default({}),
});

router.post('/from-template', requireRole('admin', 'editor'), requireScope('api:write'), validate('json', fromTemplateSchema), async (c) => {
  const body = getValidated<z.infer<typeof fromTemplateSchema>>(c, 'json');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = getDb();

  // Import all modules to search their templates
  const { GitHubModule } = await import('@sentinel/module-github');
  const { RegistryModule } = await import('@sentinel/module-registry');
  const { ChainModule } = await import('@sentinel/module-chain');
  const { InfraModule } = await import('@sentinel/module-infra');
  const { AwsModule } = await import('@sentinel/module-aws');
  const modules = [GitHubModule, RegistryModule, ChainModule, InfraModule, AwsModule];

  const mod = modules.find((m) => m.id === body.moduleId);
  if (!mod) return c.json({ error: `Module "${body.moduleId}" not found` }, 404);

  const template = mod.templates.find((t) => t.slug === body.templateSlug);
  if (!template) return c.json({ error: `Template "${body.templateSlug}" not found` }, 404);

  const detectionName = body.name ?? template.name;

  const effectiveInputs = buildEffectiveTemplateInputs(template, body.inputs);
  const builtConfigs = template.rules.map((r) => applyTemplateInputs(r.config, effectiveInputs));
  finalizeTemplateRuleConfigs(builtConfigs);
  await injectNetworkSlugIntoChainConfigs(body.moduleId, builtConfigs);
  const unresolved = filterUnresolvedForTemplate(findUnresolvedPlaceholders(builtConfigs), template);
  if (unresolved.length > 0) {
    return c.json({ error: `Missing required inputs: ${unresolved.join(', ')}` }, 400);
  }

  // Validate upstream resources exist
  const mergedConfig = { ...effectiveInputs, ...body.overrides };
  const prereq = await validatePrerequisites(body.moduleId, orgId, mergedConfig, builtConfigs);
  if (!prereq.ok) {
    return c.json({ error: prereq.error }, 400);
  }

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
      config: { ...effectiveInputs, ...body.overrides },
    }).returning();

    const ruleRows = await tx.insert(rules).values(
      template.rules.map((r, i) => ({
        detectionId: detection.id,
        orgId,
        moduleId: body.moduleId,
        ruleType: r.ruleType,
        config: builtConfigs[i],
        action: r.action,
        priority: r.priority ?? 50,
      })),
    ).returning();

    return { detection, rules: ruleRows };
  });

  // Notify module poll systems about new rules
  await syncRulesToModule('add', body.moduleId, result.rules);

  return c.json({ data: result, ...(prereq.warnings ? { warnings: prereq.warnings } : {}) }, 201);
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

router.post('/:id/test', requireScope('api:read'), validate('param', idParamSchema), async (c) => {
  const orgId = c.get('orgId')!;
  const { id: detectionId } = getValidated<z.infer<typeof idParamSchema>>(c, 'param');
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
      id: randomUUID(),
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
  const { RegistryModule } = await import('@sentinel/module-registry');
  const { ChainModule } = await import('@sentinel/module-chain');
  const { InfraModule } = await import('@sentinel/module-infra');
  const { AwsModule } = await import('@sentinel/module-aws');
  const { compoundEvaluator } = await import('@sentinel/shared/evaluators/compound');
  const modules = [GitHubModule, RegistryModule, ChainModule, InfraModule, AwsModule];

  const { RuleEngine } = await import('@sentinel/shared/rule-engine');
  const { getSharedRedis } = await import('../redis.js');

  const evaluators = new Map();
  for (const mod of modules) {
    for (const evaluator of mod.evaluators) {
      evaluators.set(`${evaluator.moduleId}:${evaluator.ruleType}`, evaluator);
    }
  }
  evaluators.set(`${compoundEvaluator.moduleId}:${compoundEvaluator.ruleType}`, compoundEvaluator);

  const redis = getSharedRedis();
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
});

export { router as detectionsRouter };
