import { z } from 'zod';
import { apiGet, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerGithubTools(server: McpServer) {
  server.tool(
    'github-repo-activity',
    'All GitHub events for a specific repository. Filter by event type (push, pull_request, etc.) or time window.',
    {
      repoFullName: z.string().describe('e.g. "myorg/myrepo"'),
      eventType: z.string().optional(),
      since: z.string().datetime().optional(),
      limit: z.number().int().positive().max(200).default(50),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/github/repo-activity', params))),
  );

  server.tool(
    'github-actor-activity',
    'All GitHub events attributed to a specific actor login across all monitored repositories.',
    {
      login: z.string().describe('GitHub username'),
      since: z.string().datetime().optional(),
      limit: z.number().int().positive().max(200).default(50),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/github/actor-activity', params))),
  );

  server.tool(
    'github-installations',
    'GitHub App installations for the org: app slug, target account, permissions granted, and webhook event subscriptions.',
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => ok(await safe(() => apiGet('/api/github/installations'))),
  );

  server.tool(
    'github-repos',
    'Monitored GitHub repositories: visibility, default branch, archived status, last sync time.',
    { search: z.string().optional().describe('Substring search on full_name') },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/github/repos', params))),
  );
}
