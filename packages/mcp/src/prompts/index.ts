/**
 * MCP Prompts — reusable investigation workflows the agent can invoke by name.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer) {
  server.prompt(
    'investigate-alert',
    'Deep-dive investigation of a specific alert: loads alert detail, its detection, correlation rule (if correlated), and synthesizes findings.',
    { alertId: z.string().describe('Numeric alert ID') },
    ({ alertId }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Investigate alert ${alertId} thoroughly:
1. Call get-alert with id="${alertId}" to get the full alert, triggerData, and raw event payload.
2. If it has a detectionId, call get-detection to understand the rule configuration.
3. If triggerType is "correlated", extract the correlationRuleId from triggerData and call get-correlation-rule.
4. If there is an eventId, use event-entity-timeline with the key identifier from the event payload to find related activity.
5. Check list-notification-deliveries for alertId=${alertId} to see if notifications were delivered.
6. Synthesize: What happened? Which rule fired and why? Is this a true positive? What should be done?`,
        },
      }],
    }),
  );

  server.prompt(
    'triage-alert-queue',
    'Triage the current alert queue: get stats, surface critical/high alerts, cluster by type, and recommend priority order.',
    {},
    () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Triage the current Sentinel alert queue:
1. Call get-alert-stats to understand the overall volume and severity distribution.
2. Call list-alerts with severity="critical" and limit=20 to see the most urgent alerts.
3. Call list-alerts with severity="high" and limit=20 for the next tier.
4. Group the alerts by module and triggerType. Identify any clusters (multiple alerts from the same detection or entity).
5. Return a prioritized triage list with: alert ID, title, severity, why it's important, and recommended first action.`,
        },
      }],
    }),
  );

  server.prompt(
    'detection-coverage-audit',
    'Audit detection coverage for a module: identify gaps, redundancies, and recommend templates to add.',
    { moduleId: z.string().describe('Module to audit: chain | infra | aws | registry | github') },
    ({ moduleId }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Audit detection coverage for the "${moduleId}" module:
1. Call list-modules-and-event-types to see all event types the module produces.
2. Call list-detections with moduleId="${moduleId}" to see what's currently monitored.
3. Call resolve-detection-template with moduleId="${moduleId}" to see available templates.
4. Compare: which event types have no detection? Which templates aren't deployed? Are any detections paused or disabled?
5. Return a gap analysis with specific recommendations: which templates to deploy, which detections to review, and any redundancies.`,
        },
      }],
    }),
  );

  server.prompt(
    'tune-noisy-detection',
    'Analyze a noisy detection and suggest tuning: adjust thresholds, add suppressors, or update cooldown.',
    { detectionId: z.string().uuid().describe('Detection UUID') },
    ({ detectionId }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Tune the noisy detection ${detectionId}:
1. Call get-detection with id="${detectionId}" to understand the rule configuration.
2. Call list-alerts with detectionId="${detectionId}" and limit=50 to see recent firing patterns.
3. If there are recent alerts, call get-event for 3-5 of the eventIds to examine the raw payloads.
4. Call test-detection with detectionId="${detectionId}" and a sample event to verify the rule behavior.
5. Based on the patterns, suggest: threshold adjustments, resource scope narrowing (hostScope), cooldown increase, or a suppress rule. Then call update-detection if appropriate.`,
        },
      }],
    }),
  );

  server.prompt(
    'write-correlation-rule',
    'Draft and create a correlation rule from a natural language description.',
    { description: z.string().describe('What pattern to correlate, e.g. "branch protection disabled then push within 1 hour by same actor"') },
    ({ description }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Create a correlation rule for: "${description}"

Steps:
1. Call list-modules-and-event-types to understand which modules and event types are relevant.
2. Call get-sample-event-fields for the relevant moduleId+eventType pairs to see available payload fields.
3. Draft a CorrelationRuleConfig:
   - type: "sequence" (for ordered events), "aggregation" (for count thresholds), or "absence" (for missing expected events)
   - correlationKey: array of {field, alias} entries that link events (e.g. same actor or same repo)
   - windowMinutes: the time window
   - steps/aggregation/absence: the specific config for the type
4. Call create-correlation-rule with the drafted config, a name, and appropriate severity.
5. Confirm the rule was created and explain what it will detect.`,
        },
      }],
    }),
  );

  server.prompt(
    'diagnose-silent-alert',
    'Diagnose why an expected alert did not fire: check detection health, delivery channels, and test the detection.',
    {
      detectionId: z.string().uuid().describe('Detection UUID that should have fired'),
      expectedTime: z.string().datetime().describe('ISO datetime when the alert was expected'),
    },
    ({ detectionId, expectedTime }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Diagnose why detection ${detectionId} did not fire around ${expectedTime}:
1. Call get-detection with id="${detectionId}" — check if status is "active" and cooldown isn't blocking.
2. Call list-alerts with detectionId="${detectionId}" and a time window around ${expectedTime} — did it actually fire?
3. Call search-events with moduleId from the detection and a time window around ${expectedTime} — did the events arrive?
4. If events exist, call test-detection with one of the event IDs to see if it would trigger now.
5. Call list-notification-deliveries filtered to recent alerts from this detection — were deliveries failing?
6. Synthesize: Did the event arrive? Did the rule evaluate? Did it fire but notifications failed? Or did no matching event arrive?`,
        },
      }],
    }),
  );

  server.prompt(
    'incident-timeline',
    'Build a full incident timeline for an entity across all Sentinel modules.',
    {
      entityId: z.string().describe('Entity identifier: address, hostname, ARN, username, digest, etc.'),
      from: z.string().datetime().describe('Incident start time (ISO)'),
      to: z.string().datetime().describe('Incident end time (ISO)'),
    },
    ({ entityId, from, to }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Build a complete incident timeline for entity: "${entityId}" between ${from} and ${to}

1. Call event-entity-timeline with entity="${entityId}", from="${from}", to="${to}" — this is the primary cross-module signal.
2. Call list-alerts with from="${from}", to="${to}" and search="${entityId}" — which alerts fired during this window?
3. For each unique moduleId in the timeline, note what event types appeared and in what order.
4. Call get-alert for any critical/high alerts in the window to get full triggerData.
5. Assemble a chronological narrative:
   - What was observed first?
   - How did activity progress across modules?
   - Which detections fired and when?
   - What is the most likely explanation for the activity?
   - What follow-up actions are recommended?`,
        },
      }],
    }),
  );
}
