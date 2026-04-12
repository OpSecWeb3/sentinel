import { z } from 'zod';
import { apiGet, safe, ok, safeStructured } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerEventTools(server: McpServer) {
  server.registerTool(
    'search-events',
    {
      description: 'Search events by moduleId, eventType, full-text search across externalId+eventType+payload, and date range.',
      inputSchema: {
        moduleId: z.string().optional(),
        eventType: z.string().optional(),
        search: z.string().max(255).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (params) => ok(await safe(() => apiGet('/api/events', params))),
  );

  server.registerTool(
    'get-event',
    {
      description: 'Get a single event by UUID with full payload.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => ok(await safe(() => apiGet(`/api/events/${id}`))),
  );

  server.registerTool(
    'event-entity-timeline',
    {
      description: 'THE killer tool: given any identifier (address, ARN, hostname, username, digest, repo name, IP...), searches all event payloads across every module and returns a chronological timeline. Use to answer "what does Sentinel know about X?"',
      inputSchema: {
        entity: z.string().describe('Any identifier to search for across all event payloads'),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().positive().max(500).default(100),
      },
      outputSchema: {
        entity: z.string(),
        count: z.number(),
        data: z.array(z.object({
          id: z.string(),
          moduleId: z.string(),
          eventType: z.string(),
          externalId: z.string().nullable(),
          occurredAt: z.string(),
          receivedAt: z.string(),
          payload: z.record(z.string(), z.unknown()),
        })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      return safeStructured(() => apiGet('/api/events/timeline', params));
    },
  );

  server.registerTool(
    'event-search-payload',
    {
      description: 'Search events by a specific JSONB payload field value. Use dot-notation for nested fields (e.g. "sender.login", "repository.full_name", "principalId").',
      inputSchema: {
        field: z.string().describe('Dot-notation JSON path in payload, e.g. "address", "sender.login"'),
        value: z.string(),
        moduleId: z.string().optional(),
        eventType: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().positive().max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (params) => ok(await safe(() => apiGet('/api/events/payload-search', params))),
  );

  server.registerTool(
    'event-frequency',
    {
      description: 'Daily event counts grouped by moduleId and eventType. Useful for detecting volume spikes or unusual activity patterns.',
      inputSchema: {
        moduleId: z.string().optional(),
        eventType: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/events/frequency', params))),
  );

  server.registerTool(
    'get-event-filters',
    {
      description: 'Returns distinct moduleId and eventType values that have events in the org. Use to discover what data sources exist before querying. Response shape: { modules: string[], eventTypes: string[] }.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ok(await safe(() => apiGet('/api/events/filters'))),
  );
}
