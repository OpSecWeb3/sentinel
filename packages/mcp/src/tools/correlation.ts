import { z } from 'zod';
import { apiGet, apiPost, apiPatch, apiDelete, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCorrelationTools(server: McpServer) {
  server.tool(
    'list-correlation-rules',
    'List all correlation rules for the org.',
    { status: z.enum(['active', 'paused']).optional() },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/correlation-rules', params))),
  );

  server.tool(
    'get-correlation-rule',
    'Get a single correlation rule by ID with full config (type, correlationKey, windowMinutes, steps/aggregation/absence).',
    { id: z.string().uuid() },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ id }) => ok(await safe(() => apiGet(`/api/correlation-rules/${id}`))),
  );

  server.tool(
    'create-correlation-rule',
    'Create a new correlation rule. Config must be a CorrelationRuleConfig object with type ("sequence"|"aggregation"|"absence"), correlationKey, windowMinutes, and the appropriate steps/aggregation/absence field.',
    {
      name: z.string().min(1),
      description: z.string().optional(),
      severity: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
      config: z.record(z.string(), z.unknown()).describe('CorrelationRuleConfig JSONB'),
      channelIds: z.array(z.string().uuid()).default([]),
      cooldownMinutes: z.number().int().min(0).default(0),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (body) => ok(await safe(() => apiPost('/api/correlation-rules', body))),
  );

  server.tool(
    'update-correlation-rule',
    'Update a correlation rule: name, description, severity, status, config, channelIds, or cooldownMinutes.',
    {
      id: z.string().uuid(),
      name: z.string().optional(),
      description: z.string().optional(),
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      status: z.enum(['active', 'paused']).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      channelIds: z.array(z.string().uuid()).optional(),
      cooldownMinutes: z.number().int().min(0).optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id, ...body }) => ok(await safe(() => apiPatch(`/api/correlation-rules/${id}`, body))),
  );

  server.tool(
    'get-correlation-instances',
    'List active in-flight correlation instances from Redis for a given rule. Shows which key groups are currently being tracked in the correlation window.',
    { id: z.string().uuid().describe('Correlation rule UUID') },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ id }) => ok(await safe(() => apiGet(`/api/correlation-rules/${id}/instances`))),
  );

  server.tool(
    'clear-correlation-instances',
    'DESTRUCTIVE: Clear all active correlation instances for a rule from Redis. Resets in-flight sequence/aggregation tracking. Use only for debugging or rule resets.',
    {
      id: z.string().uuid().describe('Correlation rule UUID'),
      confirm: z.literal(true).describe('Must be true to confirm this destructive operation'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      // Elicitation: ask user to confirm destructive action before executing
      try {
        const elicitResult = await server.server.elicitInput({
          mode: 'form',
          message: `You are about to clear ALL active correlation instances for rule ${id}. This resets in-flight sequence/aggregation tracking and cannot be undone. Are you sure?`,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'boolean',
                title: 'Confirm deletion',
                description: 'Set to true to proceed with clearing all instances',
              },
            },
            required: ['confirm'],
          },
        });

        if (elicitResult.action !== 'accept' || !elicitResult.content?.confirm) {
          return ok({ cancelled: true, message: 'Operation cancelled by user.' });
        }
      } catch {
        // Elicitation not supported by this client/transport — fall through
        // and rely on the `confirm: true` parameter as the existing guard.
      }

      return ok(await safe(() => apiDelete(`/api/correlation-rules/${id}/instances`)));
    },
  );

}
