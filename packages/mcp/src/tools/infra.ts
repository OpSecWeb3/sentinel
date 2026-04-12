import { z } from 'zod';
import { apiGet, apiPost, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function registerInfraTools(server: McpServer) {
  server.registerTool(
    'infra-list-hosts',
    {
      description: 'List all monitored infrastructure hosts for the org. Optional substring search on hostname.',
      inputSchema: {
        search: z.string().optional(),
        isRoot: z.enum(['true', 'false']).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/infra/hosts', params))),
  );

  server.registerTool(
    'infra-lookup-host',
    {
      description: 'Full host intelligence: IP address, cloud provider, ASN, open ports, CDN origin records, DNS records, and last scan time. Use this to answer "what server is <hostname> on?"',
      inputSchema: { hostname: z.string().describe('Hostname to look up, e.g. "aztec-labs.com"') },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ hostname }) => ok(await safe(() => apiGet(`/api/infra/hosts/${encodeURIComponent(hostname)}`))),
  );

  server.registerTool(
    'infra-get-origin',
    {
      description: 'Return all CDN origin records for a host. Answers "what is the real server behind the CDN for <hostname>?"',
      inputSchema: { hostname: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ hostname }) => ok(await safe(() => apiGet(`/api/infra/hosts/${encodeURIComponent(hostname)}/origin`))),
  );

  server.registerTool(
    'infra-dns-history',
    {
      description: 'DNS change log for a host: add/modify/remove events per record type.',
      inputSchema: {
        hostname: z.string(),
        since: z.string().datetime().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ hostname, since }) => ok(await safe(() => apiGet(`/api/infra/hosts/${encodeURIComponent(hostname)}/dns-history`, { since }))),
  );

  server.registerTool(
    'infra-cert-expiry-report',
    {
      description: 'Report of TLS certificates expiring within N days (default 30). Returns hostname, subject, issuer, and expiry date.',
      inputSchema: { daysAhead: z.number().int().positive().default(30) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/infra/cert-expiry', params))),
  );

  server.registerTool(
    'infra-tls-analysis',
    {
      description: 'Latest TLS analysis for a host: TLS versions supported, cipher suites, weak cipher flag.',
      inputSchema: { hostname: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ hostname }) => ok(await safe(() => apiGet(`/api/infra/hosts/${encodeURIComponent(hostname)}/tls`))),
  );

  server.registerTool(
    'infra-whois',
    {
      description: 'Latest WHOIS record for a host: registrar, registration/expiry dates, name servers, EPP status.',
      inputSchema: { hostname: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ hostname }) => ok(await safe(() => apiGet(`/api/infra/hosts/${encodeURIComponent(hostname)}/whois`))),
  );

  server.registerTool(
    'infra-security-score',
    {
      description: 'Security score history for a host with category breakdown and deduction reasons.',
      inputSchema: {
        hostname: z.string(),
        limit: z.number().int().positive().max(90).default(30),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ hostname, limit }) => ok(await safe(() => apiGet(`/api/infra/hosts/${encodeURIComponent(hostname)}/score`, { limit }))),
  );

  server.registerTool(
    'infra-add-host',
    {
      description: 'Add a new infrastructure host for monitoring. Hostname must be a valid domain (not a TLD). Enqueues an initial full scan immediately.',
      inputSchema: {
        hostname: z.string().min(1).max(253).describe('Domain to monitor, e.g. "app.example.com"'),
        scanIntervalMinutes: z.number().int().min(5).default(1440).describe('Scan interval in minutes (default 24h)'),
        probeEnabled: z.boolean().default(false).describe('Enable uptime probing'),
        probeIntervalMinutes: z.number().int().min(1).default(5),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (body) => ok(await safe(() => apiPost('/modules/infra/hosts', body))),
  );

  server.registerTool(
    'infra-trigger-scan',
    {
      description: 'Trigger an immediate full scan for a monitored host. Returns a job ID for tracking.',
      inputSchema: { id: z.string().uuid().describe('Host UUID') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => ok(await safe(() => apiPost(`/modules/infra/hosts/${id}/scan`, {}))),
  );

  // --- Experimental: task-based variant of infra-trigger-scan ---
  server.experimental.tasks.registerToolTask(
    'infra-trigger-scan-task',
    {
      description:
        'Long-running variant of infra-trigger-scan. Triggers a full host scan and polls until completion. Returns the scan result when finished.',
      inputSchema: { id: z.string().uuid().describe('Host UUID') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execution: { taskSupport: 'required' },
    },
    {
      createTask: async ({ id }, extra) => {
        const task = await extra.taskStore.createTask({ ttl: 300_000, pollInterval: 5_000 });

        // Fire the scan in the background and store result when done
        (async () => {
          try {
            const result = await safe(() => apiPost(`/modules/infra/hosts/${id}/scan`, {}));
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
              content: [{ type: 'text' as const, text: `Scan failed: ${String(err)}` }],
              isError: true,
            });
          }
        })();

        return { task };
      },
      getTask: async (_args, extra) => {
        return await extra.taskStore.getTask(extra.taskId);
      },
      getTaskResult: async (_args, extra) => {
        return (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult;
      },
    },
  );
}
