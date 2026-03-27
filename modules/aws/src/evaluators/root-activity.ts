/**
 * aws:root-activity evaluator
 *
 * Fires whenever the root account is used for any API action.
 * Root usage is a high-risk signal regardless of the specific action.
 */
import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  // Specific event names to exclude from root alerts (e.g. billing events)
  excludeEventNames: z.array(z.string()).default([]),
  // Include events where errorCode is non-empty (failed root actions)
  includeFailedActions: z.boolean().default(true),
});

export const rootActivityEvaluator: RuleEvaluator = {
  moduleId: 'aws',
  ruleType: 'aws.root_activity',
  configSchema,
  uiSchema: [
    {
      key: 'excludeEventNames',
      label: 'Exclude event names',
      type: 'string-array',
      required: false,
      placeholder: 'GetBillingDetails\nViewBillingStatement',
      help: 'CloudTrail event names to suppress for root account (e.g. expected billing console actions).',
    },
    {
      key: 'includeFailedActions',
      label: 'Alert on failed root actions',
      type: 'boolean',
      required: false,
      default: true,
      help: 'Include root account events that resulted in an error (e.g. access denied). These may indicate credential testing.',
    },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!event.eventType.startsWith('aws.')) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as Record<string, unknown>;

    const identity = payload.userIdentity as Record<string, unknown> | undefined;
    if (!identity || identity.type !== 'Root') return null;

    const eventName = payload.eventName as string ?? '';
    const errorCode = payload.errorCode as string | undefined;
    const awsRegion = payload.awsRegion as string ?? '';
    const sourceIp = payload.sourceIPAddress as string ?? '';

    if (config.excludeEventNames.includes(eventName)) return null;
    if (errorCode && !config.includeFailedActions) return null;

    const title = `Root account used: ${eventName}${errorCode ? ` [${errorCode}]` : ''}`;
    const description = [
      `The AWS root account performed: ${eventName}`,
      `Region: ${awsRegion}`,
      sourceIp ? `Source IP: ${sourceIp}` : null,
      errorCode ? `Error: ${errorCode}` : null,
    ].filter(Boolean).join(' | ');

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'critical',
      title,
      description,
      triggerType: 'immediate',
      triggerData: { eventName, awsRegion, sourceIp, errorCode },
    };
  },
};
