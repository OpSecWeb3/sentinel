import { z } from 'zod';
import { apiGet, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerAwsTools(server: McpServer) {
  server.tool(
    'aws-query-events',
    'Query raw CloudTrail events. Filter by eventName, eventSource, principalId, resourceArn (JSONB containment), region, errorCode, date range. Answers "who pushed to S3 recently?"',
    {
      eventName: z.string().optional().describe('e.g. "PutObject", "CreateUser"'),
      eventSource: z.string().optional().describe('e.g. "s3.amazonaws.com", "iam.amazonaws.com"'),
      principalId: z.string().optional(),
      resourceArn: z.string().optional().describe('Full ARN — uses JSONB containment query'),
      region: z.string().optional(),
      errorCode: z.string().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().positive().max(200).default(50),
      page: z.number().int().positive().default(1),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => ok(await safe(() => apiGet('/api/aws/events', params))),
  );

  server.tool(
    'aws-principal-activity',
    'All CloudTrail actions by a principal. Returns a timeline plus a grouped summary by eventName+errorCode.',
    {
      principalId: z.string(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ principalId, ...params }) => ok(await safe(() => apiGet(`/api/aws/principal/${encodeURIComponent(principalId)}/activity`, params))),
  );

  server.tool(
    'aws-resource-history',
    'All CloudTrail events that touched a specific resource ARN. Shows who did what to this resource and when.',
    {
      resourceArn: z.string().describe('Full AWS ARN of the resource'),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().positive().max(200).default(50),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/aws/resource-history', params))),
  );

  server.tool(
    'aws-error-patterns',
    'Systematic access denial patterns: groups errors by principalId + eventName + errorCode. Surfaces IAM misconfiguration or enumeration attempts.',
    {
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().positive().max(100).default(20),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/aws/error-patterns', params))),
  );

  server.tool(
    'aws-top-actors',
    'Most active AWS principals by event count. Useful for identifying unusually active accounts.',
    {
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().positive().max(50).default(20),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/aws/top-actors', params))),
  );

  server.tool(
    'aws-account-summary',
    'AWS integration health: account IDs, monitored regions, last poll times, and any error states.',
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => ok(await safe(() => apiGet('/api/aws/integrations/summary'))),
  );
}
