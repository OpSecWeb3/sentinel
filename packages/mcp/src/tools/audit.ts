import { z } from 'zod';
import { apiGet, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerAuditTools(server: McpServer) {
  server.registerTool(
    'query-audit-log',
    {
      description: 'Query the org audit log. Filter by action, resource type, user, or date range. Shows who changed what and when.',
      inputSchema: {
        action: z.string().max(255).optional().describe('e.g. "channel.create", "detection.update"'),
        resourceType: z.string().max(255).optional().describe('e.g. "channel", "detection", "correlation_rule"'),
        userId: z.string().uuid().optional(),
        since: z.string().datetime().optional(),
        until: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/audit-log', params))),
  );
}
