import { z } from 'zod';
import { apiGet, safe, ok, safeStructured } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// --- Shared output schemas ---

const AlertSummary = z.object({
  id: z.number(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string(),
  description: z.string().nullable(),
  triggerType: z.string(),
  notificationStatus: z.string(),
  createdAt: z.string(),
  detectionId: z.string().nullable(),
  ruleId: z.string().nullable(),
  eventId: z.string().nullable(),
  detectionName: z.string().nullable(),
  moduleId: z.string().nullable(),
});

const PaginationMeta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

export function registerAlertTools(server: McpServer) {
  server.registerTool(
    'list-alerts',
    {
      description: 'List alerts with optional filters: severity, moduleId, detectionId, triggerType, search (title+description), date range, pagination.',
      inputSchema: {
        detectionId: z.string().uuid().optional(),
        moduleId: z.string().optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        triggerType: z.string().optional().describe('direct | correlated'),
        search: z.string().max(255).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(100).default(20),
      },
      outputSchema: {
        data: z.array(AlertSummary),
        meta: PaginationMeta,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => {
      return safeStructured(() => apiGet('/api/alerts', params));
    },
  );

  server.registerTool(
    'get-alert',
    {
      description: 'Get a single alert by ID with full triggerData, raw event payload, and notification delivery status.',
      inputSchema: { id: z.string().describe('Alert ID (numeric)') },
      outputSchema: {
        data: z.object({
          id: z.number(),
          orgId: z.string(),
          detectionId: z.string().nullable(),
          ruleId: z.string().nullable(),
          eventId: z.string().nullable(),
          severity: z.enum(['critical', 'high', 'medium', 'low']),
          title: z.string(),
          description: z.string().nullable(),
          triggerType: z.string(),
          triggerData: z.record(z.string(), z.unknown()),
          notificationStatus: z.string(),
          notifications: z.array(z.unknown()),
          createdAt: z.string(),
          detectionName: z.string().nullable(),
          event: z.object({
            id: z.string(),
            moduleId: z.string(),
            eventType: z.string(),
            externalId: z.string().nullable(),
            payload: z.record(z.string(), z.unknown()),
            occurredAt: z.string(),
            receivedAt: z.string(),
          }).nullable(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      return safeStructured(() => apiGet(`/api/alerts/${id}`));
    },
  );

  server.registerTool(
    'get-alert-stats',
    {
      description: 'Alert statistics: total, today, this week, active detections, breakdown by severity, 10 most recent.',
      outputSchema: {
        total: z.number(),
        today: z.number(),
        thisWeek: z.number(),
        activeDetections: z.number(),
        bySeverity: z.record(z.string(), z.number()),
        recent: z.array(z.object({
          id: z.number(),
          severity: z.string(),
          title: z.string(),
          createdAt: z.string(),
          detectionName: z.string().nullable(),
        })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      return safeStructured(() => apiGet('/api/alerts/stats'));
    },
  );
}
