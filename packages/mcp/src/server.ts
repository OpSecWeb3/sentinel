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
        'Sentinel is a security monitoring platform. You are an autonomous security agent.',
        'Your job: investigate alerts, identify threats, and build/tune detections and correlation rules.',
        '',
        '## Platform architecture',
        'Modules (chain, infra, aws, registry, github) ingest events into a shared event store.',
        'Detections contain rules that evaluate against events and fire alerts.',
        'Correlation rules detect patterns across multiple events (sequence, aggregation, absence).',
        'Notification channels deliver alerts to Slack, email, or webhooks.',
        '',
        '## Investigation workflow',
        '1. `get-alert-stats` for overall volume and severity distribution.',
        '2. `list-alerts` with severity/module/date filters to find relevant alerts.',
        '3. `get-alert` for full payload, triggerData, and the raw event that caused it.',
        '4. `event-entity-timeline` to pivot on any identifier (address, ARN, hostname, username, digest) across ALL modules.',
        '5. `event-search-payload` for targeted JSONB field queries (dot-notation: "sender.login", "repository.full_name").',
        '6. `event-frequency` to determine if a pattern is anomalous vs routine by checking daily counts.',
        '7. `get-event-filters` to discover which modules and event types have data.',
        '',
        '## Building detections',
        'Two paths: template-based (faster) or raw (full control).',
        '',
        '### Template path',
        '1. `list-modules-and-event-types` to see modules, their event types, and available template slugs.',
        '2. `resolve-template` with moduleId + slug to get the template definition: required inputs, rule blueprints, default severity.',
        '3. `create-detection-from-template` with the moduleId, templateSlug, and filled inputs. The API substitutes inputs into rule configs.',
        '',
        '### Raw path',
        '1. `get-rule-schema` with a ruleType to see what config fields the evaluator expects (field names, types, constraints).',
        '2. `get-sample-event-fields` with moduleId + eventType to see real payload field names and sample values.',
        '3. `create-detection` with moduleId, name, severity, and a rules array where each rule has ruleType + config.',
        '',
        '### Testing and tuning',
        '- ALWAYS call `test-detection` before enabling — pass an eventId from a real event or an inline event object.',
        '- `update-detection` can change status (active/paused), severity, cooldown, channelIds, or replace rules entirely.',
        '- To re-derive rules from a template with new inputs, pass templateSlug + inputs to `update-detection`.',
        '- `delete-detection` archives (soft-deletes) a detection and disables all its rules.',
        '',
        '## Correlation rules',
        'For multi-event patterns that single-event detections cannot catch.',
        '',
        '- **Sequence**: ordered steps within a time window. Config needs `steps` array with moduleId + eventType + conditions per step, plus `correlationKey` to link them (e.g. same actor).',
        '- **Aggregation**: count threshold within a window. Config needs `aggregation` with moduleId + eventType + conditions + `threshold` + `groupBy`.',
        '- **Absence**: expected event did NOT occur within window. Config needs `absence` with expected moduleId + eventType + conditions.',
        '',
        'All correlation rules require: `config.type` ("sequence"|"aggregation"|"absence"), `config.correlationKey` (array of {field, alias}), `config.windowMinutes`.',
        '',
        '- `get-correlation-instances` shows in-flight state (which key groups are being tracked).',
        '- `clear-correlation-instances` resets tracking — use for debugging or after rule changes.',
        '- `delete-correlation-rule` archives the rule and cleans up Redis state.',
        '',
        '## Notification channels',
        'Detections reference channels by UUID. Before creating a detection with channelIds, verify channels exist with `list-channels`.',
        'Channel types: "slack" (config: {channelId}), "email" (config: {recipients: string[]}), "webhook" (config: {url, secret?, headers?}).',
        'Use `test-channel` to verify connectivity. Use `get-notification-delivery` to debug failed deliveries.',
        '',
        '## Module-specific analytics',
        '- **AWS**: `aws-query-events` for CloudTrail, `aws-principal-activity` for per-identity timelines, `aws-error-patterns` for IAM issues.',
        '- **Chain**: `chain-address-activity` for on-chain events, `chain-state-history` for storage slot changes, `chain-network-status` for poller health.',
        '- **Infra**: `infra-lookup-host` for full host intelligence, `infra-security-score` for composite scoring, `infra-cert-expiry-report` for TLS hygiene.',
        '- **Registry**: `registry-artifact-summary` for monitored images/packages, `registry-unsigned-releases` for supply chain gaps.',
        '- **GitHub**: `github-repo-activity` for per-repo events, `github-actor-activity` for per-user timelines.',
        '',
        '## Key principles',
        '- Always investigate before acting. Read alerts, events, and existing detections before creating new ones.',
        '- Always test detections against real events before enabling.',
        '- Use `query-audit-log` to understand what changes were made and by whom.',
        '- Prefer templates when available — they encode best practices. Use raw detections only when no template fits.',
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

  // Register all tools (73 tools + 3 task variants)
  registerAlertTools(server);       // 3  — list-alerts, get-alert, get-alert-stats
  registerEventTools(server);       // 6  — search-events, get-event, entity-timeline, payload-search, frequency, get-event-filters
  registerDetectionTools(server);   // 9  — list, get, test, create, create-from-template, update, delete, get-rule-schema, resolve-template
  registerCorrelationTools(server); // 7  — list, get, create, update, delete, get-instances, clear-instances
  registerNotificationTools(server); // 9 — list-deliveries, get-delivery, delivery-stats, list/get/create/update/delete-channel, test-channel
  registerModuleTools(server);      // 4  — list-modules, get-sample-fields, resolve-detection-template, browse-field-catalog
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
