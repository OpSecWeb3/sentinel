/**
 * aws:spot_eviction evaluator
 *
 * Fires when AWS interrupts (evicts) a spot instance.
 * The 2-minute interruption warning arrives as a native EventBridge event:
 *   detail-type: "EC2 Spot Instance Interruption Warning"
 *
 * Useful signals:
 *  - Unexpected evictions during critical workloads
 *  - Correlation: repeated evictions may indicate bid price too low or
 *    capacity constraints in a region/AZ
 *  - Security signal: evictions of unknown instances may indicate
 *    unauthorized crypto-mining workloads being cleaned up by cost controls
 */
import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  // Specific instance IDs to watch (empty = all spot instances)
  watchInstanceIds: z.array(z.string()).default([]),
  // AWS account IDs to watch (empty = all)
  accountIds: z.array(z.string()).default([]),
  // AWS regions to watch (empty = all)
  regions: z.array(z.string()).default([]),
  // Severity to use for the alert
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});

export const spotEvictionEvaluator: RuleEvaluator = {
  moduleId: 'aws',
  ruleType: 'aws.spot_eviction',
  configSchema,
  uiSchema: [
    {
      key: 'watchInstanceIds',
      label: 'Watch specific instance IDs',
      type: 'string-array',
      required: false,
      placeholder: 'i-0abc123def456\ni-0xyz789',
      help: 'Leave empty to alert on all spot evictions. One instance ID per line.',
    },
    {
      key: 'accountIds',
      label: 'AWS account IDs',
      type: 'string-array',
      required: false,
      placeholder: '123456789012',
      help: 'Limit to specific AWS accounts. Leave empty for all accounts.',
    },
    {
      key: 'regions',
      label: 'AWS regions',
      type: 'string-array',
      required: false,
      placeholder: 'us-east-1\neu-west-1',
      help: 'Limit alerts to specific regions. Leave empty for all regions.',
    },
    {
      key: 'severity',
      label: 'Alert severity',
      type: 'select',
      required: false,
      default: 'medium',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'critical', label: 'Critical' },
      ],
      help: 'Set higher if spot instances run critical workloads.',
    },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    if (event.eventType !== 'aws.ec2.SpotInstanceInterruption') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as Record<string, unknown>;

    const awsRegion = payload.awsRegion as string ?? payload.region as string ?? '';
    const detail = payload.detail as Record<string, unknown> | undefined;
    const instanceId = detail?.['instance-id'] as string ?? '';
    const action = detail?.['instance-action'] as string ?? 'terminate';

    const accountId = payload.accountId as string ?? payload.account as string ?? '';

    if (config.accountIds.length > 0 && !config.accountIds.includes(accountId)) return null;
    if (config.regions.length > 0 && !config.regions.includes(awsRegion)) return null;
    if (config.watchInstanceIds.length > 0 && !config.watchInstanceIds.includes(instanceId)) return null;

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: config.severity,
      title: `Spot instance eviction: ${instanceId || 'unknown'} in ${awsRegion}`,
      description: [
        `AWS is reclaiming spot instance ${instanceId}.`,
        `Action: ${action}`,
        `Region: ${awsRegion}`,
        'Instance will be terminated within 2 minutes.',
      ].filter(Boolean).join(' | '),
      triggerType: 'immediate',
      triggerData: { instanceId, awsRegion, action },
    };
  },
};
