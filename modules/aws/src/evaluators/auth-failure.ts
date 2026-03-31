/**
 * aws:auth-failure evaluator
 *
 * Detects console login failures and MFA-related anomalies.
 * High volume of auth failures can indicate a brute-force attack or
 * credential stuffing against the AWS Console.
 */
import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  // Alert on any console login failure
  alertOnLoginFailure: z.boolean().default(true),
  // Alert on successful root console login
  alertOnRootLogin: z.boolean().default(true),
  // Alert on login without MFA
  alertOnNoMfa: z.boolean().default(false),
  // AWS account IDs to watch (empty = all)
  accountIds: z.array(z.string()).default([]),
});

export const authFailureEvaluator: RuleEvaluator = {
  moduleId: 'aws',
  ruleType: 'aws.auth_failure',
  configSchema,
  uiSchema: [
    {
      key: 'alertOnLoginFailure',
      label: 'Alert on console login failure',
      type: 'boolean',
      required: false,
      default: true,
      help: 'Fire when a ConsoleLogin event has a "Failed authentication" or error response.',
    },
    {
      key: 'alertOnRootLogin',
      label: 'Alert on root console login',
      type: 'boolean',
      required: false,
      default: true,
      help: 'Fire when the root account successfully logs in to the console.',
    },
    {
      key: 'alertOnNoMfa',
      label: 'Alert on login without MFA',
      type: 'boolean',
      required: false,
      default: false,
      help: 'Fire when any user logs in to the console without MFA.',
    },
    {
      key: 'accountIds',
      label: 'AWS account IDs',
      type: 'string-array',
      required: false,
      placeholder: '123456789012',
      help: 'Limit to specific AWS accounts. Leave empty for all accounts.',
    },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    // Only applies to console sign-in events
    if (event.eventType !== 'aws.signin.ConsoleLogin') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as Record<string, unknown>;

    const identity = payload.userIdentity as Record<string, unknown> | undefined;
    const userType = identity?.type as string ?? '';
    const userArn = identity?.arn as string ?? '';
    const accountId = identity?.accountId as string ?? '';

    if (config.accountIds.length > 0 && !config.accountIds.includes(accountId)) return null;
    const sourceIp = payload.sourceIPAddress as string ?? '';
    const awsRegion = payload.awsRegion as string ?? '';

    const responseElements = payload.responseElements as Record<string, unknown> | undefined;
    const loginResult = responseElements?.ConsoleLogin as string ?? '';
    const additionalEventData = payload.additionalEventData as Record<string, unknown> | undefined;
    const mfaUsed = additionalEventData?.MFAUsed as string ?? 'No';
    const isMfaUsed = mfaUsed === 'Yes';

    const isFailure = loginResult === 'Failure';
    const isRoot = userType === 'Root';

    if (isFailure && config.alertOnLoginFailure) {
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: isRoot ? 'critical' : 'high',
        title: `AWS console login failure${isRoot ? ' (root account)' : ''}`,
        description: [
          isRoot ? 'Root account' : (userArn || accountId),
          `failed to sign in to the AWS console.`,
          `Source IP: ${sourceIp}`,
          `Region: ${awsRegion}`,
        ].filter(Boolean).join(' '),
        triggerType: 'immediate',
        triggerData: { userType, userArn, sourceIp, awsRegion, loginResult, mfaUsed },
      };
    }

    if (isRoot && !isFailure && config.alertOnRootLogin) {
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'critical',
        title: 'Root account console login',
        description: [
          'The AWS root account signed in to the console.',
          `Source IP: ${sourceIp}`,
          `Region: ${awsRegion}`,
          `MFA: ${mfaUsed}`,
        ].filter(Boolean).join(' | '),
        triggerType: 'immediate',
        triggerData: { userType, sourceIp, awsRegion, mfaUsed, loginResult },
      };
    }

    if (!isFailure && !isMfaUsed && config.alertOnNoMfa) {
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'medium',
        title: `Console login without MFA`,
        description: [
          `User signed in without MFA:`,
          userArn || accountId,
          `Source IP: ${sourceIp}`,
        ].filter(Boolean).join(' | '),
        triggerType: 'immediate',
        triggerData: { userType, userArn, sourceIp, awsRegion, mfaUsed },
      };
    }

    return null;
  },
};
