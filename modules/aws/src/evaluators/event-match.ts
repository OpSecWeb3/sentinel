/**
 * aws:event-match evaluator
 *
 * Matches CloudTrail events based on configurable field filters:
 *   - eventName (exact or glob)
 *   - eventSource
 *   - userType (Root, IAMUser, AssumedRole, etc.)
 *   - principalArn (exact or partial match)
 *   - errorCode (non-empty = error events only)
 *   - sourceIpCidr
 *   - awsRegion
 */
import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  // Event name patterns, e.g. ["CreateUser", "Delete*"]
  eventNames: z.array(z.string()).default([]),
  // Event source patterns, e.g. ["iam.amazonaws.com"]
  eventSources: z.array(z.string()).default([]),
  // User types to match, e.g. ["Root", "IAMUser"]
  userTypes: z.array(z.string()).default([]),
  // Principal ARN substrings/patterns
  principalArnPatterns: z.array(z.string()).default([]),
  // Only match when CloudTrail records an error (errorCode is non-empty)
  errorEventsOnly: z.boolean().default(false),
  // Match specific error codes
  errorCodes: z.array(z.string()).default([]),
  // AWS account IDs to watch (empty = all)
  accountIds: z.array(z.string()).default([]),
  // AWS regions to watch (empty = all)
  regions: z.array(z.string()).default([]),
  // Severity to use for the alert
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  // Alert title template (supports {{eventName}}, {{principalId}}, {{awsRegion}})
  alertTitle: z.string().default('AWS CloudTrail: {{eventName}} by {{principalId}}'),
});

function matchesAny(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => minimatch(value, p, { nocase: true }) || value.toLowerCase().includes(p.toLowerCase()));
}

export const eventMatchEvaluator: RuleEvaluator = {
  moduleId: 'aws',
  ruleType: 'aws.event_match',
  configSchema,
  uiSchema: [
    {
      key: 'eventNames',
      label: 'Event names',
      type: 'string-array',
      required: false,
      placeholder: 'CreateUser\nDelete*\nPutBucketAcl',
      help: 'CloudTrail event names to match. Supports glob patterns. Leave empty to match all.',
    },
    {
      key: 'eventSources',
      label: 'Event sources',
      type: 'string-array',
      required: false,
      placeholder: 'iam.amazonaws.com\ns3.amazonaws.com',
      help: 'CloudTrail event sources (AWS service endpoints). Leave empty to match all.',
    },
    {
      key: 'userTypes',
      label: 'User types',
      type: 'string-array',
      required: false,
      placeholder: 'Root\nIAMUser\nAssumedRole',
      help: 'CloudTrail userIdentity.type values. Leave empty to match all.',
    },
    {
      key: 'principalArnPatterns',
      label: 'Principal ARN patterns',
      type: 'string-array',
      required: false,
      placeholder: 'arn:aws:iam::*:user/admin-*',
      help: 'Patterns for the ARN of the caller. Supports glob and substring match.',
    },
    {
      key: 'errorEventsOnly',
      label: 'Error events only',
      type: 'boolean',
      required: false,
      default: false,
      help: 'Only alert when CloudTrail records an error (access denied, throttled, etc.)',
    },
    {
      key: 'errorCodes',
      label: 'Specific error codes',
      type: 'string-array',
      required: false,
      placeholder: 'AccessDenied\nUnauthorizedOperation',
      help: 'Match only specific CloudTrail error codes. Requires errorEventsOnly or can be used standalone.',
    },
    {
      key: 'accountIds',
      label: 'AWS account IDs',
      type: 'string-array',
      required: false,
      placeholder: '123456789012\n987654321098',
      help: 'Limit to specific AWS accounts. Leave empty for all accounts.',
    },
    {
      key: 'regions',
      label: 'AWS regions',
      type: 'string-array',
      required: false,
      placeholder: 'us-east-1\neu-west-1',
      help: 'Limit to specific AWS regions. Leave empty for all regions.',
    },
    {
      key: 'severity',
      label: 'Alert severity',
      type: 'select',
      required: false,
      default: 'high',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'critical', label: 'Critical' },
      ],
      help: 'Severity for alerts when this rule matches.',
    },
    {
      key: 'alertTitle',
      label: 'Alert title',
      type: 'text',
      required: false,
      default: 'AWS CloudTrail: {{eventName}} by {{principalId}}',
      help: 'Supports {{eventName}}, {{principalId}}, {{awsRegion}}, {{accountId}}.',
    },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!event.eventType.startsWith('aws.')) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as Record<string, unknown>;

    const eventName = payload.eventName as string ?? '';
    const eventSource = payload.eventSource as string ?? '';
    const awsRegion = payload.awsRegion as string ?? '';
    const errorCode = payload.errorCode as string | undefined;
    const identity = payload.userIdentity as Record<string, unknown> | undefined;
    const principalId = identity?.principalId as string ?? '';
    const userArn = identity?.arn as string ?? '';
    const userType = identity?.type as string ?? '';
    const accountId = identity?.accountId as string ?? '';

    // Apply filters
    if (config.eventNames.length > 0 && !matchesAny(eventName, config.eventNames)) return null;
    if (config.eventSources.length > 0 && !matchesAny(eventSource, config.eventSources)) return null;
    if (config.userTypes.length > 0 && !config.userTypes.some((t) => t.toLowerCase() === userType.toLowerCase())) return null;
    if (config.principalArnPatterns.length > 0 && !matchesAny(userArn, config.principalArnPatterns)) return null;
    if (config.accountIds.length > 0 && !config.accountIds.includes(accountId)) return null;
    if (config.regions.length > 0 && !config.regions.includes(awsRegion)) return null;
    if (config.errorEventsOnly && !errorCode) return null;
    if (config.errorCodes.length > 0 && (!errorCode || !config.errorCodes.includes(errorCode))) return null;

    const title = config.alertTitle
      .replace('{{eventName}}', eventName)
      .replace('{{principalId}}', principalId || userArn || 'unknown')
      .replace('{{awsRegion}}', awsRegion)
      .replace('{{accountId}}', accountId);

    const description = [
      `Event: ${eventName}`,
      `Source: ${eventSource}`,
      `Region: ${awsRegion}`,
      principalId ? `Principal: ${principalId}` : null,
      userArn ? `ARN: ${userArn}` : null,
      errorCode ? `Error: ${errorCode}` : null,
    ].filter(Boolean).join(' | ');

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: config.severity,
      title,
      description,
      triggerType: 'immediate',
      triggerData: { eventName, eventSource, awsRegion, principalId, userArn, errorCode, accountId },
    };
  },
};
