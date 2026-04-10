import { z } from 'zod';
import { apiGet, apiPost, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRegistryTools(server: McpServer) {
  server.tool(
    'registry-artifact-summary',
    'List all monitored artifacts (Docker images + npm packages) with active tag count and last push date.',
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => ok(await safe(() => apiGet('/api/registry/artifacts/summary'))),
  );

  server.tool(
    'registry-digest-history',
    'Digest change log for an artifact: when each tag\'s image was replaced, with old/new digest and pusher.',
    {
      artifactName: z.string().describe('e.g. "myorg/myapp" or "@scope/pkg"'),
      tag: z.string().optional().describe('Filter to a specific tag, e.g. "latest"'),
      limit: z.number().int().positive().max(200).default(50),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/registry/digest-history', params))),
  );

  server.tool(
    'registry-attribution-report',
    'Attribution status breakdown: which artifact changes were verified to CI, inferred, suspicious, or unattributed.',
    {
      artifactName: z.string().optional(),
      limit: z.number().int().positive().max(200).default(50),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/registry/attribution-report', params))),
  );

  server.tool(
    'registry-unsigned-releases',
    'List active artifact versions lacking cosign signature or SLSA provenance. Use for supply chain security audits.',
    { artifactName: z.string().optional() },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/registry/unsigned-releases', params))),
  );

  server.tool(
    'registry-ci-notifications',
    'Recent CI pipeline push notifications: what digest each workflow claimed to produce, and whether it matched the observed digest.',
    {
      since: z.string().datetime().optional(),
      limit: z.number().int().positive().max(200).default(50),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (params) => ok(await safe(() => apiGet('/api/registry/ci-notifications', params))),
  );

  server.tool(
    'registry-add-image',
    'Add a Docker image for monitoring. Tracks tag digests, attribution, and signature status.',
    {
      name: z.string().min(1).describe('Image name, e.g. "library/nginx" or "myorg/myapp"'),
      tagPatterns: z.array(z.string()).default(['*']).describe('Glob patterns for tags to watch'),
      ignorePatterns: z.array(z.string()).default([]),
      pollIntervalSeconds: z.number().int().min(60).default(300),
      githubRepo: z.string().regex(/^[^/]+\/[^/]+$/).optional().describe('Linked GitHub repo for CI attribution, e.g. "myorg/myrepo"'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (body) => ok(await safe(() => apiPost('/api/registry/images', body))),
  );

  server.tool(
    'registry-add-package',
    'Add an npm package for monitoring. Tracks version digests, attribution, and signature status.',
    {
      name: z.string().min(1).describe('Package name, e.g. "@acme/sdk" or "lodash"'),
      tagPatterns: z.array(z.string()).default(['*']).describe('Glob patterns for dist-tags/versions to watch'),
      ignorePatterns: z.array(z.string()).default([]),
      pollIntervalSeconds: z.number().int().min(60).default(300),
      githubRepo: z.string().regex(/^[^/]+\/[^/]+$/).optional().describe('Linked GitHub repo for CI attribution'),
      watchMode: z.enum(['dist-tags', 'versions']).default('versions'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (body) => ok(await safe(() => apiPost('/api/registry/packages', body))),
  );
}
