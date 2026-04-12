import { z } from 'zod';
import { apiGet, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerAwsTools(server: McpServer) {
  server.registerTool(
    'aws-query-events',
    {
      description: 'Query raw CloudTrail events. Use "search" for free-text partial matching across eventName, eventSource, principalId, userArn, sourceIp, errorCode. Use exact filters for precise lookups. Answers "who pushed to S3 recently?"',
      inputSchema: {
        search: z.string().max(255).optional().describe('Free-text search across eventName, eventSource, principalId, userArn, sourceIp, errorCode (ILIKE)'),
        eventName: z.string().optional().describe('Exact match, e.g. "PutObject", "CreateUser"'),
        eventSource: z.string().optional().describe('Exact match, e.g. "s3.amazonaws.com", "iam.amazonaws.com"'),
        principalId: z.string().optional(),
        resourceArn: z.string().optional().describe('Full ARN — uses JSONB containment query'),
        region: z.string().optional(),
        errorCode: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().positive().max(200).default(50),
        page: z.number().int().positive().default(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (params) => ok(await safe(() => apiGet('/api/aws/events', params))),
  );

  server.registerTool(
    'aws-principal-activity',
    {
      description: 'All CloudTrail actions by a principal. Returns a timeline plus a grouped summary by eventName+errorCode.',
      inputSchema: {
        principalId: z.string(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ principalId, ...params }) => ok(await safe(() => apiGet(`/api/aws/principal/${encodeURIComponent(principalId)}/activity`, params))),
  );

  server.registerTool(
    'aws-resource-history',
    {
      description: 'All CloudTrail events that touched a specific resource ARN. Shows who did what to this resource and when.',
      inputSchema: {
        resourceArn: z.string().describe('Full AWS ARN of the resource'),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().positive().max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/aws/resource-history', params))),
  );

  server.registerTool(
    'aws-error-patterns',
    {
      description: 'Systematic access denial patterns: groups errors by principalId + eventName + errorCode. Surfaces IAM misconfiguration or enumeration attempts.',
      inputSchema: {
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().positive().max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/aws/error-patterns', params))),
  );

  server.registerTool(
    'aws-top-actors',
    {
      description: 'Most active AWS principals by event count. Useful for identifying unusually active accounts.',
      inputSchema: {
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().positive().max(50).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/aws/top-actors', params))),
  );

  server.registerTool(
    'aws-account-summary',
    {
      description: 'AWS integration health: account IDs, monitored regions, last poll times, and any error states.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ok(await safe(() => apiGet('/api/aws/integrations/summary'))),
  );
}
