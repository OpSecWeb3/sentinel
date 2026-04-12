/**
 * MCP Resources — URI-addressable data objects the agent can read directly.
 */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, safe } from '../client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function toText(data: unknown, uri: string) {
  return {
    contents: [{
      uri,
      mimeType: 'application/json' as const,
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function registerResources(server: McpServer) {
  // Static resources
  server.registerResource(
    'alert-stats',
    'sentinel://alerts/stats',
    { description: 'Live alert statistics: total, today, this week, by severity, 10 most recent' },
    async (uri) => toText(await safe(() => apiGet('/api/alerts/stats')), uri.href),
  );

  server.registerResource(
    'modules-metadata',
    'sentinel://modules/metadata',
    { description: 'All modules, their event types, evaluators, and detection templates' },
    async (uri) => toText(await safe(() => apiGet('/api/modules/metadata')), uri.href),
  );

  // Template resources
  server.registerResource(
    'alert-detail',
    new ResourceTemplate('sentinel://alerts/{id}', { list: undefined }),
    { description: 'Single alert with triggerData, event payload, and delivery status' },
    async (uri, variables) => {
      const id = variables.id as string;
      return toText(await safe(() => apiGet(`/api/alerts/${id}`)), uri.href);
    },
  );

  server.registerResource(
    'detection-detail',
    new ResourceTemplate('sentinel://detections/{id}', { list: undefined }),
    { description: 'Detection with all rules and full config' },
    async (uri, variables) => {
      const id = variables.id as string;
      return toText(await safe(() => apiGet(`/api/detections/${id}`)), uri.href);
    },
  );

  server.registerResource(
    'correlation-rule-detail',
    new ResourceTemplate('sentinel://correlation-rules/{id}', { list: undefined }),
    { description: 'Correlation rule with full config JSONB' },
    async (uri, variables) => {
      const id = variables.id as string;
      return toText(await safe(() => apiGet(`/api/correlation-rules/${id}`)), uri.href);
    },
  );

  server.registerResource(
    'correlation-instances',
    new ResourceTemplate('sentinel://correlation-rules/{id}/instances', { list: undefined }),
    { description: 'Active in-flight correlation instances from Redis' },
    async (uri, variables) => {
      const id = variables.id as string;
      return toText(await safe(() => apiGet(`/api/correlation-rules/${id}/instances`)), uri.href);
    },
  );

  server.registerResource(
    'event-detail',
    new ResourceTemplate('sentinel://events/{id}', { list: undefined }),
    { description: 'Single event with full JSONB payload' },
    async (uri, variables) => {
      const id = variables.id as string;
      return toText(await safe(() => apiGet(`/api/events/${id}`)), uri.href);
    },
  );

  server.registerResource(
    'infra-host',
    new ResourceTemplate('sentinel://infra/hosts/{hostname}', { list: undefined }),
    { description: 'Full host intelligence: IP, cloud provider, CDN origin, DNS records, last scan' },
    async (uri, variables) => {
      const hostname = variables.hostname as string;
      return toText(
        await safe(() => apiGet(`/api/infra/hosts/${encodeURIComponent(hostname)}`)),
        uri.href,
      );
    },
  );
}
