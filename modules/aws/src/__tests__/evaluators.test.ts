import { describe, it, expect } from 'vitest';
import type { EvalContext, NormalizedEvent, RuleRow } from '@sentinel/shared/rules';
import { authFailureEvaluator } from '../evaluators/auth-failure.js';
import { rootActivityEvaluator } from '../evaluators/root-activity.js';
import { eventMatchEvaluator } from '../evaluators/event-match.js';
import { spotEvictionEvaluator } from '../evaluators/spot-eviction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'evt-1',
    orgId: 'org-1',
    moduleId: 'aws',
    eventType: 'aws.signin.ConsoleLogin',
    externalId: 'ext-1',
    payload: {},
    occurredAt: new Date('2026-03-26T12:00:00Z'),
    receivedAt: new Date('2026-03-26T12:00:01Z'),
    ...overrides,
  };
}

function makeRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 'rule-1',
    detectionId: 'det-1',
    orgId: 'org-1',
    moduleId: 'aws',
    ruleType: 'aws.auth_failure',
    config: {},
    status: 'active',
    priority: 1,
    action: 'alert',
    ...overrides,
  };
}

function makeCtx(event: NormalizedEvent, rule: RuleRow): EvalContext {
  return { event, rule, redis: {} as any };
}

// ===========================================================================
// authFailureEvaluator
// ===========================================================================

describe('authFailureEvaluator', () => {
  const baseLoginPayload = {
    eventName: 'ConsoleLogin',
    eventSource: 'signin.amazonaws.com',
    userIdentity: {
      type: 'IAMUser',
      arn: 'arn:aws:iam::123456:user/alice',
      accountId: '123456',
      principalId: 'AIDA123',
    },
    responseElements: { ConsoleLogin: 'Success' },
    additionalEventData: { MFAUsed: 'Yes' },
    sourceIPAddress: '1.2.3.4',
    awsRegion: 'us-east-1',
  };

  it('returns null for non-ConsoleLogin events', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: { eventName: 'CreateUser', eventSource: 'iam.amazonaws.com' },
    });
    const rule = makeRule({ ruleType: 'aws.auth_failure', config: {} });
    const result = await authFailureEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('fires on login failure (default config)', async () => {
    const event = makeEvent({
      payload: {
        ...baseLoginPayload,
        responseElements: { ConsoleLogin: 'Failure' },
        additionalEventData: { MFAUsed: 'No' },
      },
    });
    const rule = makeRule({ ruleType: 'aws.auth_failure', config: {} });
    const result = await authFailureEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('login failure');
  });

  it('returns critical severity for root login failure', async () => {
    const event = makeEvent({
      payload: {
        ...baseLoginPayload,
        userIdentity: {
          type: 'Root',
          arn: 'arn:aws:iam::123456:root',
          accountId: '123456',
          principalId: '123456',
        },
        responseElements: { ConsoleLogin: 'Failure' },
        additionalEventData: { MFAUsed: 'No' },
      },
    });
    const rule = makeRule({ ruleType: 'aws.auth_failure', config: {} });
    const result = await authFailureEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('root');
  });

  it('fires on successful root login (alertOnRootLogin=true)', async () => {
    const event = makeEvent({
      payload: {
        ...baseLoginPayload,
        userIdentity: {
          type: 'Root',
          arn: 'arn:aws:iam::123456:root',
          accountId: '123456',
          principalId: '123456',
        },
        responseElements: { ConsoleLogin: 'Success' },
        additionalEventData: { MFAUsed: 'Yes' },
      },
    });
    const rule = makeRule({
      ruleType: 'aws.auth_failure',
      config: { alertOnRootLogin: true },
    });
    const result = await authFailureEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('Root account console login');
  });

  it('fires on login without MFA (alertOnNoMfa=true)', async () => {
    const event = makeEvent({
      payload: {
        ...baseLoginPayload,
        responseElements: { ConsoleLogin: 'Success' },
        additionalEventData: { MFAUsed: 'No' },
      },
    });
    const rule = makeRule({
      ruleType: 'aws.auth_failure',
      config: { alertOnNoMfa: true, alertOnRootLogin: false },
    });
    const result = await authFailureEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('without MFA');
  });

  it('does not fire on successful non-root login with MFA (default config)', async () => {
    const event = makeEvent({
      payload: {
        ...baseLoginPayload,
        responseElements: { ConsoleLogin: 'Success' },
        additionalEventData: { MFAUsed: 'Yes' },
      },
    });
    const rule = makeRule({ ruleType: 'aws.auth_failure', config: {} });
    const result = await authFailureEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// rootActivityEvaluator
// ===========================================================================

describe('rootActivityEvaluator', () => {
  const baseRootPayload = {
    eventName: 'CreateUser',
    eventSource: 'iam.amazonaws.com',
    userIdentity: {
      type: 'Root',
      arn: 'arn:aws:iam::123456:root',
      accountId: '123456',
      principalId: '123456',
    },
    awsRegion: 'us-east-1',
    sourceIPAddress: '1.2.3.4',
  };

  it('returns null for non-aws events', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      moduleId: 'github',
      payload: {},
    });
    const rule = makeRule({ ruleType: 'aws.root_activity', config: {} });
    const result = await rootActivityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for non-Root userIdentity', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: {
        ...baseRootPayload,
        userIdentity: {
          type: 'IAMUser',
          arn: 'arn:aws:iam::123456:user/alice',
          principalId: 'AIDA123',
          accountId: '123456',
        },
      },
    });
    const rule = makeRule({ ruleType: 'aws.root_activity', config: {} });
    const result = await rootActivityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('fires for any root API action', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: baseRootPayload,
    });
    const rule = makeRule({ ruleType: 'aws.root_activity', config: {} });
    const result = await rootActivityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('Root account used');
    expect(result!.title).toContain('CreateUser');
  });

  it('includes error code in title when present', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: {
        ...baseRootPayload,
        errorCode: 'AccessDenied',
      },
    });
    const rule = makeRule({ ruleType: 'aws.root_activity', config: {} });
    const result = await rootActivityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('[AccessDenied]');
  });

  it('respects excludeEventNames config', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.GetBillingDetails',
      payload: {
        ...baseRootPayload,
        eventName: 'GetBillingDetails',
      },
    });
    const rule = makeRule({
      ruleType: 'aws.root_activity',
      config: { excludeEventNames: ['GetBillingDetails'] },
    });
    const result = await rootActivityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('respects includeFailedActions=false config', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: {
        ...baseRootPayload,
        errorCode: 'AccessDenied',
      },
    });
    const rule = makeRule({
      ruleType: 'aws.root_activity',
      config: { includeFailedActions: false },
    });
    const result = await rootActivityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// eventMatchEvaluator
// ===========================================================================

describe('eventMatchEvaluator', () => {
  const baseMatchPayload = {
    eventName: 'CreateUser',
    eventSource: 'iam.amazonaws.com',
    awsRegion: 'us-east-1',
    userIdentity: {
      type: 'IAMUser',
      arn: 'arn:aws:iam::123456:user/alice',
      principalId: 'AIDA123',
      accountId: '123456',
    },
  };

  it('returns null for non-aws events', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      moduleId: 'github',
      payload: {},
    });
    const rule = makeRule({ ruleType: 'aws.event_match', config: {} });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('matches when all filters pass', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: baseMatchPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.event_match',
      config: {
        eventNames: ['CreateUser'],
        eventSources: ['iam.amazonaws.com'],
        userTypes: ['IAMUser'],
        regions: ['us-east-1'],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.triggerType).toBe('immediate');
  });

  it('filters by eventName glob patterns', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: baseMatchPayload,
    });

    // Should match: "Create*"
    const ruleMatch = makeRule({
      ruleType: 'aws.event_match',
      config: { eventNames: ['Create*'] },
    });
    const resultMatch = await eventMatchEvaluator.evaluate(makeCtx(event, ruleMatch));
    expect(resultMatch).not.toBeNull();

    // Should not match: "Delete*"
    const ruleNoMatch = makeRule({
      ruleType: 'aws.event_match',
      config: { eventNames: ['Delete*'] },
    });
    const resultNoMatch = await eventMatchEvaluator.evaluate(makeCtx(event, ruleNoMatch));
    expect(resultNoMatch).toBeNull();
  });

  it('filters by region', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: baseMatchPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.event_match',
      config: { regions: ['eu-west-1'] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('filters by userType', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: baseMatchPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.event_match',
      config: { userTypes: ['Root'] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('respects errorEventsOnly', async () => {
    // No error code in payload — should be filtered out
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: baseMatchPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.event_match',
      config: { errorEventsOnly: true },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();

    // With error code — should match
    const eventWithError = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: { ...baseMatchPayload, errorCode: 'AccessDenied' },
    });
    const resultWithError = await eventMatchEvaluator.evaluate(makeCtx(eventWithError, rule));
    expect(resultWithError).not.toBeNull();
  });

  it('supports template variables in alertTitle', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: baseMatchPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.event_match',
      config: {
        alertTitle: 'Alert: {{eventName}} in {{awsRegion}} by {{principalId}}',
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Alert: CreateUser in us-east-1 by AIDA123');
  });
});

// ===========================================================================
// spotEvictionEvaluator
// ===========================================================================

describe('spotEvictionEvaluator', () => {
  const baseSpotPayload = {
    eventName: 'EC2 Spot Instance Interruption Warning',
    eventSource: 'aws.ec2',
    awsRegion: 'us-west-2',
    region: 'us-west-2',
    accountId: '123456',
    userIdentity: { type: 'AWSService', principalId: 'aws.ec2' },
    detail: {
      'instance-id': 'i-0abc123def456',
      'instance-action': 'terminate',
    },
  };

  it('returns null for non-SpotInstanceInterruption events', async () => {
    const event = makeEvent({
      eventType: 'aws.iam.CreateUser',
      payload: { eventName: 'CreateUser' },
    });
    const rule = makeRule({ ruleType: 'aws.spot_eviction', config: {} });
    const result = await spotEvictionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('fires on spot interruption event', async () => {
    const event = makeEvent({
      eventType: 'aws.ec2.SpotInstanceInterruption',
      payload: baseSpotPayload,
    });
    const rule = makeRule({ ruleType: 'aws.spot_eviction', config: {} });
    const result = await spotEvictionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('i-0abc123def456');
    expect(result!.title).toContain('us-west-2');
  });

  it('respects region filter', async () => {
    const event = makeEvent({
      eventType: 'aws.ec2.SpotInstanceInterruption',
      payload: baseSpotPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.spot_eviction',
      config: { regions: ['eu-west-1'] },
    });
    const result = await spotEvictionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('respects watchInstanceIds filter', async () => {
    const event = makeEvent({
      eventType: 'aws.ec2.SpotInstanceInterruption',
      payload: baseSpotPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.spot_eviction',
      config: { watchInstanceIds: ['i-other-instance'] },
    });
    const result = await spotEvictionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('passes watchInstanceIds filter when instance matches', async () => {
    const event = makeEvent({
      eventType: 'aws.ec2.SpotInstanceInterruption',
      payload: baseSpotPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.spot_eviction',
      config: { watchInstanceIds: ['i-0abc123def456'] },
    });
    const result = await spotEvictionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('uses configured severity', async () => {
    const event = makeEvent({
      eventType: 'aws.ec2.SpotInstanceInterruption',
      payload: baseSpotPayload,
    });
    const rule = makeRule({
      ruleType: 'aws.spot_eviction',
      config: { severity: 'critical' },
    });
    const result = await spotEvictionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });
});
