import { z } from 'zod';
import { apiGet, apiPost, apiPatch, apiDelete, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerNotificationTools(server: McpServer) {
  server.registerTool(
    'list-notification-deliveries',
    {
      description: 'List notification deliveries. Filter by alertId, channelType, status, or date range.',
      inputSchema: {
        alertId: z.string().optional(),
        channelType: z.string().optional().describe('slack | email | webhook | pagerduty'),
        status: z.enum(['pending', 'sent', 'failed']).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/notification-deliveries', params))),
  );

  server.registerTool(
    'get-delivery-stats',
    {
      description: 'Notification delivery statistics: success/failure counts by channel type, recent error samples.',
      inputSchema: {
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/notification-deliveries/stats', params))),
  );

  // --- Notification Channels ---

  server.registerTool(
    'list-channels',
    {
      description: 'List all notification channels (email, webhook, Slack). Filter by type.',
      inputSchema: {
        type: z.enum(['email', 'webhook', 'slack']).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/channels', params))),
  );

  server.registerTool(
    'get-channel',
    {
      description: 'Get a notification channel by ID with full configuration.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => ok(await safe(() => apiGet(`/api/channels/${id}`))),
  );

  server.registerTool(
    'create-channel',
    {
      description: 'Create a notification channel. Config varies by type: email needs {recipients: string[]}, webhook needs {url, secret?, headers?}, slack needs {channelId}.',
      inputSchema: {
        name: z.string().min(1).max(255),
        type: z.enum(['email', 'webhook', 'slack']),
        config: z.record(z.string(), z.unknown()).describe('Type-specific config: {recipients} for email, {url, secret?, headers?} for webhook, {channelId} for slack'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (body) => ok(await safe(() => apiPost('/api/channels', body))),
  );

  server.registerTool(
    'update-channel',
    {
      description: 'Update a notification channel: name, config, or enabled status.',
      inputSchema: {
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        enabled: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, ...body }) => ok(await safe(() => apiPatch(`/api/channels/${id}`, body))),
  );

  server.registerTool(
    'test-channel',
    {
      description: 'Send a test notification to a channel to verify connectivity.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => ok(await safe(() => apiPost(`/api/channels/${id}/test`, {}))),
  );

  server.registerTool(
    'delete-channel',
    {
      description: 'Archive a notification channel (soft delete). Detections linked to this channel will no longer send notifications through it.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => ok(await safe(() => apiDelete(`/api/channels/${id}`))),
  );

  server.registerTool(
    'get-notification-delivery',
    {
      description: 'Get a single notification delivery by ID with full details: channel config used, request/response bodies, error message if failed, timestamps.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => ok(await safe(() => apiGet(`/api/notification-deliveries/${id}`))),
  );
}
