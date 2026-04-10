import { z } from 'zod';
import { apiGet, apiPost, apiPatch, safe, ok, structured } from '../client.js';
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

  server.tool(
    'get-detection',
    'Get a detection by ID including all its rules with full config JSONB.',
    { id: z.string().uuid() },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ id }) => ok(await safe(() => apiGet(`/api/detections/${id}`))),
  );

  server.tool(
    'test-detection',
    'Dry-run a detection against a test event without side effects. Provide eventId to load from DB, or an inline event object. Returns wouldTrigger, suppressed, candidates, rulesEvaluated.',
    {
      detectionId: z.string().uuid(),
      eventId: z.string().uuid().optional().describe('Load an existing event from DB by UUID'),
      event: z.object({
        eventType: z.string(),
        payload: z.record(z.string(), z.unknown()),
      }).optional().describe('Inline event to test with'),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ detectionId, eventId, event }) => {
      return ok(await safe(() => apiPost(`/api/detections/${detectionId}/test`, { eventId, event })));
    },
  );

  server.tool(
    'create-detection-from-template',
    'Create a detection from a module template slug. Resolves the template, inserts the detection and rules.',
    {
      moduleId: z.string().describe('chain | infra | aws | registry | github'),
      templateSlug: z.string().describe('Template slug, e.g. "balance-threshold", "digest-change"'),
      name: z.string().optional().describe('Override the template name'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      inputs: z.record(z.string(), z.unknown()).default({}).describe('Template input parameters'),
      channelIds: z.array(z.string().uuid()).default([]),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (body) => ok(await safe(() => apiPost('/api/detections', body))),
  );

  server.tool(
    'update-detection',
    'Update a detection: name, description, severity, cooldown minutes, or status.',
    {
      id: z.string().uuid(),
      name: z.string().optional(),
      description: z.string().optional(),
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      status: z.enum(['active', 'paused', 'disabled']).optional(),
      cooldownMinutes: z.number().int().min(0).optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id, ...body }) => ok(await safe(() => apiPatch(`/api/detections/${id}`, body))),
  );

}
