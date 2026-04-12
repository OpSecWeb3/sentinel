import { z } from 'zod';
import { apiGet, apiPost, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRegistryTools(server: McpServer) {
  server.registerTool(
    'registry-artifact-summary',
    {
      description: 'List all monitored artifacts (Docker images + npm packages) with active tag count and last push date.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ok(await safe(() => apiGet('/api/registry/artifacts/summary'))),
  );

  server.registerTool(
    'registry-digest-history',
    {
      description: 'Digest change log for an artifact: when each tag\'s image was replaced, with old/new digest and pusher.',
      inputSchema: {
        artifactName: z.string().describe('e.g. "myorg/myapp" or "@scope/pkg"'),
        tag: z.string().optional().describe('Filter to a specific tag, e.g. "latest"'),
        limit: z.number().int().positive().max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/registry/digest-history', params))),
  );

  server.registerTool(
    'registry-attribution-report',
    {
      description: 'Attribution status breakdown: which artifact changes were verified to CI, inferred, suspicious, or unattributed.',
      inputSchema: {
        artifactName: z.string().optional(),
        limit: z.number().int().positive().max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/registry/attribution-report', params))),
  );

  server.registerTool(
    'registry-unsigned-releases',
    {
      description: 'List active artifact versions lacking cosign signature or SLSA provenance. Use for supply chain security audits.',
      inputSchema: { artifactName: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/registry/unsigned-releases', params))),
  );

  server.registerTool(
    'registry-ci-notifications',
    {
      description: 'Recent CI pipeline push notifications: what digest each workflow claimed to produce, and whether it matched the observed digest.',
      inputSchema: {
        since: z.string().datetime().optional(),
        limit: z.number().int().positive().max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/registry/ci-notifications', params))),
  );

  server.registerTool(
    'registry-add-image',
    {
      description: 'Add a Docker image for monitoring. Tracks tag digests, attribution, and signature status.',
      inputSchema: {
        name: z.string().min(1).describe('Image name, e.g. "library/nginx" or "myorg/myapp"'),
        tagPatterns: z.array(z.string()).default(['*']).describe('Glob patterns for tags to watch'),
        ignorePatterns: z.array(z.string()).default([]),
        pollIntervalSeconds: z.number().int().min(60).default(300),
        githubRepo: z.string().regex(/^[^/]+\/[^/]+$/).optional().describe('Linked GitHub repo for CI attribution, e.g. "myorg/myrepo"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (body) => ok(await safe(() => apiPost('/modules/registry/images', body))),
  );

  server.registerTool(
    'registry-add-package',
    {
      description: 'Add an npm package for monitoring. Tracks version digests, attribution, and signature status.',
      inputSchema: {
        name: z.string().min(1).describe('Package name, e.g. "@acme/sdk" or "lodash"'),
        tagPatterns: z.array(z.string()).default(['*']).describe('Glob patterns for dist-tags/versions to watch'),
        ignorePatterns: z.array(z.string()).default([]),
        pollIntervalSeconds: z.number().int().min(60).default(300),
        githubRepo: z.string().regex(/^[^/]+\/[^/]+$/).optional().describe('Linked GitHub repo for CI attribution'),
        watchMode: z.enum(['dist-tags', 'versions']).default('versions'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (body) => ok(await safe(() => apiPost('/modules/registry/packages', body))),
  );
}
