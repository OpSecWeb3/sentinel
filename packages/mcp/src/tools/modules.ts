import { z } from 'zod';
import { apiGet, safe, ok } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function registerModuleTools(server: McpServer) {
  server.registerTool(
    'list-modules-and-event-types',
    {
      description: 'List all Sentinel modules and their registered event types, evaluators, and template slugs.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ok(await safe(() => apiGet('/api/modules/metadata'))),
  );

  server.registerTool(
    'get-sample-event-fields',
    {
      description: 'Inspect the most recent event of a given moduleId+eventType and return the top-level payload field names with sample values. Useful before writing an event-search-payload query.',
      inputSchema: {
        moduleId: z.string(),
        eventType: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/events', { ...params, limit: 1 }))),
  );

  server.registerTool(
    'resolve-detection-template',
    {
      description: 'Look up available detection templates for a module, showing slug, name, description, required inputs, and default severity.',
      inputSchema: {
        moduleId: z.string().describe('chain | infra | aws | registry | github'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/modules/metadata', params))),
  );

  server.registerTool(
    'browse-field-catalog',
    {
      description: 'Browse discovered field paths across events and alerts. Useful for understanding available payload fields before writing detection rules or searches.',
      inputSchema: {
        source: z.enum(['events', 'alerts']).optional(),
        sourceType: z.string().optional().describe('e.g. specific eventType or alert type'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (params) => ok(await safe(() => apiGet('/api/field-catalog', params))),
  );

  // --- Experimental: task-based variant of resolve-detection-template ---
  server.experimental.tasks.registerToolTask(
    'resolve-detection-template-task',
    {
      description:
        'Long-running variant of resolve-detection-template. Fetches and resolves module templates, which may involve network calls to fetch remote template definitions.',
      inputSchema: {
        moduleId: z.string().describe('chain | infra | aws | registry | github'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: 'required' },
    },
    {
      createTask: async ({ moduleId }, extra) => {
        const task = await extra.taskStore.createTask({ ttl: 120_000, pollInterval: 3_000 });

        (async () => {
          try {
            const result = await safe(() => apiGet('/api/modules/metadata', { moduleId }));
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
              content: [{ type: 'text' as const, text: `Template resolution failed: ${String(err)}` }],
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
