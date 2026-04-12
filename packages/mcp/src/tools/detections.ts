import { z } from 'zod';
import { apiGet, apiPost, apiPatch, apiDelete, safe, ok, structured } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerDetectionTools(server: McpServer) {
  server.registerTool(
    'list-detections',
    {
      description: 'List detections with optional filters by module, status, severity, or name search. Includes rule count per detection.',
      inputSchema: {
        moduleId: z.string().optional(),
        status: z.enum(['active', 'paused', 'disabled']).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        search: z.string().max(255).optional(),
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
      },
      outputSchema: {
        data: z.array(z.object({
          id: z.string(),
          moduleId: z.string(),
          templateId: z.string().nullable(),
          name: z.string(),
          description: z.string().nullable(),
          severity: z.enum(['critical', 'high', 'medium', 'low']),
          status: z.string(),
          cooldownMinutes: z.number(),
          lastTriggeredAt: z.string().nullable(),
          createdAt: z.string(),
          updatedAt: z.string(),
          ruleCount: z.number(),
        })),
        meta: z.object({
          page: z.number(),
          limit: z.number(),
          total: z.number(),
          totalPages: z.number(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => {
      const result = await safe(() => apiGet('/api/detections', params));
      return structured(result as Record<string, unknown>);
    },
  );

  server.registerTool(
    'get-detection',
    {
      description: 'Get a detection by ID including all its rules with full config JSONB.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => ok(await safe(() => apiGet(`/api/detections/${id}`))),
  );

  server.registerTool(
    'test-detection',
    {
      description: 'Dry-run a detection against a test event without side effects. Provide eventId to load from DB, or an inline event object. Returns wouldTrigger, suppressed, candidates, rulesEvaluated.',
      inputSchema: {
        detectionId: z.string().uuid(),
        eventId: z.string().uuid().optional().describe('Load an existing event from DB by UUID'),
        event: z.object({
          eventType: z.string(),
          payload: z.record(z.string(), z.unknown()),
        }).optional().describe('Inline event to test with'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ detectionId, eventId, event }) => {
      return ok(await safe(() => apiPost(`/api/detections/${detectionId}/test`, { eventId, event })));
    },
  );

  server.registerTool(
    'create-detection',
    {
      description: 'Create a detection with explicit rules. Use when you need full control over rule configuration rather than using a template. Each rule needs a ruleType (from get-rule-schema) and a config object.',
      inputSchema: {
        moduleId: z.string().describe('chain | infra | aws | registry | github'),
        name: z.string().min(1).max(255),
        description: z.string().max(1000).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
        channelIds: z.array(z.string().uuid()).default([]),
        cooldownMinutes: z.number().int().min(0).max(1440).default(0),
        config: z.record(z.string(), z.unknown()).default({}).describe('Detection-level config (e.g. hostIds, artifactName)'),
        rules: z.array(z.object({
          ruleType: z.string().min(1).describe('Rule evaluator type — use get-rule-schema to discover available types'),
          config: z.record(z.string(), z.unknown()).describe('Rule-specific config JSONB'),
          action: z.enum(['alert', 'log', 'suppress']).default('alert'),
          priority: z.number().int().min(0).max(100).default(50),
        })).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (body) => ok(await safe(() => apiPost('/api/detections', body))),
  );

  server.registerTool(
    'create-detection-from-template',
    {
      description: 'Create a detection from a module template slug. Resolves the template, substitutes inputs into rule configs, and inserts the detection. Use resolve-template first to see required inputs.',
      inputSchema: {
        moduleId: z.string().describe('chain | infra | aws | registry | github'),
        templateSlug: z.string().describe('Template slug, e.g. "balance-threshold", "digest-change"'),
        name: z.string().optional().describe('Override the template name'),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        inputs: z.record(z.string(), z.unknown()).default({}).describe('Template input parameters — fill required inputs from resolve-template'),
        overrides: z.record(z.string(), z.unknown()).default({}).describe('Detection-level config overrides (e.g. hostIds, artifactName)'),
        channelIds: z.array(z.string().uuid()).default([]),
        cooldownMinutes: z.number().int().min(0).max(1440).default(5),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (body) => ok(await safe(() => apiPost('/api/detections/from-template', body))),
  );

  server.registerTool(
    'update-detection',
    {
      description: 'Update a detection. Can change metadata (name, severity, status, cooldown), replace rules directly, or re-derive rules from a template with new inputs.',
      inputSchema: {
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(1000).nullable().optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        status: z.enum(['active', 'paused']).optional(),
        cooldownMinutes: z.number().int().min(0).max(1440).optional(),
        channelIds: z.array(z.string().uuid()).optional(),
        config: z.record(z.string(), z.unknown()).optional().describe('Detection-level config overrides'),
        rules: z.array(z.object({
          ruleType: z.string().min(1),
          config: z.record(z.string(), z.unknown()),
          action: z.enum(['alert', 'log', 'suppress']).default('alert'),
          priority: z.number().int().min(0).max(100).default(50),
        })).min(1).optional().describe('Replace all rules with this set'),
        templateSlug: z.string().optional().describe('Re-derive rules from template'),
        inputs: z.record(z.string(), z.unknown()).optional().describe('New template inputs when using templateSlug'),
        overrides: z.record(z.string(), z.unknown()).optional().describe('Config overrides when using templateSlug'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, ...body }) => ok(await safe(() => apiPatch(`/api/detections/${id}`, body))),
  );

  server.registerTool(
    'delete-detection',
    {
      description: 'Archive a detection (soft delete). Sets status to disabled and disables all its rules. Use when a detection is redundant, noisy beyond repair, or no longer needed.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => ok(await safe(() => apiDelete(`/api/detections/${id}`))),
  );

  server.registerTool(
    'get-rule-schema',
    {
      description: 'Get the UI schema (available fields, types, constraints) for a rule type. Essential before creating or updating detection rules — shows what config fields are expected.',
      inputSchema: {
        ruleType: z.string().min(1).describe('Rule evaluator type, e.g. "balance-threshold", "dns-change", "cloudtrail-match"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/detections/rule-schema', params))),
  );

  server.registerTool(
    'resolve-template',
    {
      description: 'Resolve a specific detection template by module and slug. Returns the template definition with name, description, severity, required inputs, and rule blueprints. Use before create-detection-from-template to understand required inputs.',
      inputSchema: {
        moduleId: z.string().describe('chain | infra | aws | registry | github'),
        slug: z.string().describe('Template slug, e.g. "balance-threshold", "digest-change"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/detections/resolve-template', params))),
  );
}
