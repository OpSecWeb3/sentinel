/**
 * Shared MCP server factory.
 * Creates and configures the McpServer with all tools, resources, and prompts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';

import { registerAlertTools } from './tools/alerts.js';
import { registerEventTools } from './tools/events.js';
import { registerDetectionTools } from './tools/detections.js';
import { registerCorrelationTools } from './tools/correlation.js';
import { registerNotificationTools } from './tools/notifications.js';
import { registerModuleTools } from './tools/modules.js';
import { registerInfraTools } from './tools/infra.js';
import { registerAwsTools } from './tools/aws.js';
import { registerChainTools } from './tools/chain.js';
import { registerRegistryTools } from './tools/registry.js';
import { registerGithubTools } from './tools/github.js';
import { registerAuditTools } from './tools/audit.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'sentinel',
      version: '1.0.0',
    },
    {
      instructions: [
        'Sentinel is a security monitoring platform. Use these workflows for best results:',
        '',
        '## Investigation workflow',
        '1. Start with `list-alerts` to see recent alerts (filter by severity/status).',
        '2. Use `get-alert` to inspect a specific alert and read its payload.',
        '3. Pivot to `search-events` or `entity-timeline` to see what happened around the same entity or time window.',
        '4. Use `payload-search` for deep JSONB queries when you know the field path.',
        '5. Use `frequency` to check whether an event pattern is anomalous or routine.',
        '',
        '## Detection management',
        '1. `list-modules-and-event-types` shows available modules, event types, and template slugs.',
        '2. `resolve-detection-template` shows available templates and their required inputs for a module.',
        '3. `test-detection` dry-runs a detection against a real or inline event — always test before enabling.',
        '4. `create-detection-from-template` creates a detection with rules from a template.',
        '5. `update-detection` changes severity, status (active/paused/disabled), or cooldown.',
        '',
        '## Infrastructure monitoring',
        '1. `infra-list-hosts` → `infra-lookup-host` for full host intelligence (IP, ASN, ports, CDN).',
        '2. `infra-dns-history` and `infra-cert-expiry-report` for DNS/TLS hygiene.',
        '3. `infra-security-score` for a composite score with category breakdown.',
        '4. `infra-trigger-scan` to force an immediate rescan of a host.',
        '',
        '## Correlation rules',
        'Use correlation rules when you need to detect patterns across multiple events:',
        '- **Sequence**: ordered steps that must occur within a time window (e.g., login → privilege escalation → data export).',
        '- **Aggregation**: threshold-based (e.g., >10 failed logins in 5 minutes for the same principal).',
        '- **Absence**: alert when an expected event does NOT occur within a window.',
        'Always use `get-correlation-instances` to inspect in-flight state before clearing.',
      ].join('\n'),
      // Enable experimental task support for long-running operations
      capabilities: {
        tasks: {
          requests: { tools: { call: {} } },
        },
      },
      taskStore: new InMemoryTaskStore(),
    },
  );

  // Register all tools (65 total)
  registerAlertTools(server);       // 3  — list-alerts, get-alert, get-alert-stats
  registerEventTools(server);       // 5  — search-events, get-event, entity-timeline, payload-search, frequency
  registerDetectionTools(server);   // 5  — list, get, test, create-from-template, update
  registerCorrelationTools(server); // 6  — list, get, create, update, get-instances, clear-instances
  registerNotificationTools(server); // 7 — list-deliveries, delivery-stats, list/get/create/update-channel, test-channel
  registerModuleTools(server);      // 4  — list-modules, get-sample-fields, resolve-template, browse-field-catalog
  registerInfraTools(server);       // 10 — list-hosts, lookup, origin, dns-history, cert-expiry, tls, whois, score, add-host, trigger-scan
  registerAwsTools(server);         // 6  — query-events, principal-activity, resource-history, error-patterns, top-actors, account-summary
  registerChainTools(server);       // 7  — address-activity, balance-history, state-history, network-status, rpc-usage, add-contract, discover-storage
  registerRegistryTools(server);    // 7  — artifact-summary, digest-history, attribution-report, unsigned-releases, ci-notifications, add-image, add-package
  registerGithubTools(server);      // 4  — repo-activity, actor-activity, installations, repos
  registerAuditTools(server);       // 1  — query-audit-log

  // Register URI resources
  registerResources(server);

  // Register investigation prompts
  registerPrompts(server);

  return server;
}
