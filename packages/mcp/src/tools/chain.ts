import { z } from 'zod';
import { apiGet, apiPost, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function registerChainTools(server: McpServer) {
  server.registerTool(
    'chain-address-activity',
    {
      description: 'All on-chain events for an address across all monitored networks. Answers "what has happened with 0xabc... recently?"',
      inputSchema: {
        address: z.string().describe('Ethereum address (0x...)'),
        networkId: z.number().int().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().positive().max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/chain/address-activity', params))),
  );

  server.registerTool(
    'chain-balance-history',
    {
      description: 'Balance snapshot history for a tracked address/rule. Shows value changes over time with block numbers.',
      inputSchema: {
        ruleId: z.string().uuid().optional(),
        address: z.string().optional(),
        networkId: z.number().int().optional(),
        limit: z.number().int().positive().max(500).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/chain/balance-history', params))),
  );

  server.registerTool(
    'chain-state-history',
    {
      description: 'Storage slot value timeline for a contract. Shows how a specific storage slot changed over time.',
      inputSchema: {
        ruleId: z.string().uuid().optional(),
        address: z.string().optional(),
        slot: z.string().optional().describe('Storage slot identifier'),
        limit: z.number().int().positive().max(500).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/chain/state-history', params))),
  );

  server.registerTool(
    'chain-network-status',
    {
      description: 'Block cursor positions per network — shows the last polled block for each chain. Use to check if pollers are healthy or behind.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ok(await safe(() => apiGet('/api/chain/network-status'))),
  );

  server.registerTool(
    'chain-rpc-usage',
    {
      description: 'Hourly RPC call counts by network, template, and method. Useful for cost monitoring and identifying high-frequency polling rules.',
      inputSchema: {
        networkId: z.number().int().optional(),
        since: z.string().datetime().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/chain/rpc-usage', params))),
  );

  server.registerTool(
    'chain-add-contract',
    {
      description: 'Add a smart contract for monitoring. Provide network slug, address, and label. Optionally pass an ABI or set fetchAbi to auto-fetch from block explorer.',
      inputSchema: {
        networkSlug: z.string().min(1).describe('Network slug, e.g. "ethereum", "arbitrum"'),
        address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Contract address (0x...)'),
        label: z.string().min(1),
        tags: z.array(z.string()).default([]),
        notes: z.string().optional(),
        abi: z.unknown().optional().describe('Contract ABI JSON (optional)'),
        fetchAbi: z.boolean().default(false).describe('Auto-fetch ABI from block explorer'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (body) => ok(await safe(() => apiPost('/modules/chain/contracts', body))),
  );

  server.registerTool(
    'chain-discover-storage',
    {
      description: 'Trigger storage layout discovery for a monitored contract. Analyzes storage slots for state-watching rules.',
      inputSchema: { contractId: z.number().int().describe('Contract ID (numeric)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ contractId }) => ok(await safe(() => apiPost(`/modules/chain/contracts/${contractId}/analyze-storage`, {}))),
  );

  // --- Experimental: task-based variant of chain-discover-storage ---
  server.experimental.tasks.registerToolTask(
    'chain-discover-storage-task',
    {
      description:
        'Long-running variant of chain-discover-storage. Triggers storage layout discovery and polls until the analysis completes.',
      inputSchema: { contractId: z.number().int().describe('Contract ID (numeric)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execution: { taskSupport: 'required' },
    },
    {
      createTask: async ({ contractId }, extra) => {
        const task = await extra.taskStore.createTask({ ttl: 300_000, pollInterval: 5_000 });

        (async () => {
          try {
            const result = await safe(() =>
              apiPost(`/modules/chain/contracts/${contractId}/analyze-storage`, {}),
            );
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
              content: [{ type: 'text' as const, text: `Storage discovery failed: ${String(err)}` }],
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
