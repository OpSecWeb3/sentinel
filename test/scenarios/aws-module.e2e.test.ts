/**
 * AWS Module E2E Tests
 *
 * Integration tests that exercise AWS evaluators against a real Postgres DB
 * and Redis instance via the RuleEngine. Covers root account activity,
 * console login anomalies, CloudTrail event matching, and access denied
 * monitoring across all four AWS evaluator types.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTestDb,
  getTestRedis,
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestRule,
  createTestEvent,
} from '../../test/helpers/setup.js';

import { RuleEngine } from '@sentinel/shared/rule-engine';
import type { NormalizedEvent, RuleEvaluator } from '@sentinel/shared/rules';
import { rootActivityEvaluator } from '../../modules/aws/src/evaluators/root-activity.js';
import { authFailureEvaluator } from '../../modules/aws/src/evaluators/auth-failure.js';
import { eventMatchEvaluator } from '../../modules/aws/src/evaluators/event-match.js';
import { spotEvictionEvaluator } from '../../modules/aws/src/evaluators/spot-eviction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the evaluator registry from a list of evaluators. */
function buildRegistry(...evaluators: RuleEvaluator[]): Map<string, RuleEvaluator> {
  const map = new Map<string, RuleEvaluator>();
  for (const ev of evaluators) {
    map.set(`${ev.moduleId}:${ev.ruleType}`, ev);
  }
  return map;
}

/** Create a NormalizedEvent from a DB event row + payload. */
function toNormalizedEvent(
  row: { id: string; orgId: string; moduleId: string; eventType: string },
  payload: Record<string, unknown>,
): NormalizedEvent {
  return {
    id: row.id,
    orgId: row.orgId,
    moduleId: row.moduleId,
    eventType: row.eventType,
    externalId: null,
    payload,
    occurredAt: new Date(),
    receivedAt: new Date(),
  };
}

/**
 * Build a minimal AWS CloudTrail normalized payload.
 * Fields not passed are filled with sensible defaults.
 */
function awsPayload(overrides: {
  eventName?: string;
  eventSource?: string;
  awsRegion?: string;
  principalId?: string;
  userIdentity?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  responseElements?: Record<string, unknown>;
  requestParameters?: Record<string, unknown>;
  additionalEventData?: Record<string, unknown>;
  sourceIPAddress?: string;
} = {}): Record<string, unknown> {
  return {
    eventName: overrides.eventName ?? 'DescribeInstances',
    eventSource: overrides.eventSource ?? 'ec2.amazonaws.com',
    awsRegion: overrides.awsRegion ?? 'us-east-1',
    principalId: overrides.principalId ?? 'AIDAEXAMPLE',
    userIdentity: overrides.userIdentity ?? {
      type: 'IAMUser',
      arn: 'arn:aws:iam::123456789012:user/testuser',
      accountId: '123456789012',
      principalId: 'AIDAEXAMPLE',
      userName: 'testuser',
    },
    ...(overrides.errorCode !== undefined && { errorCode: overrides.errorCode }),
    ...(overrides.errorMessage !== undefined && { errorMessage: overrides.errorMessage }),
    ...(overrides.responseElements !== undefined && { responseElements: overrides.responseElements }),
    ...(overrides.requestParameters !== undefined && { requestParameters: overrides.requestParameters }),
    ...(overrides.additionalEventData !== undefined && { additionalEventData: overrides.additionalEventData }),
    ...(overrides.sourceIPAddress !== undefined && { sourceIPAddress: overrides.sourceIPAddress }),
  };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let db: ReturnType<typeof getTestDb>;
let redis: ReturnType<typeof getTestRedis>;
let user: Awaited<ReturnType<typeof createTestUser>>;
let org: Awaited<ReturnType<typeof createTestOrg>>;

beforeEach(async () => {
  await cleanTables();
  resetCounters();
  db = getTestDb();
  redis = getTestRedis();

  user = await createTestUser({ username: 'aws-module-tester' });
  org = await createTestOrg({ name: 'AWS Module Org', slug: 'aws-module-org' });
  await addMembership(org.id, user.id, 'admin');
});

// ==========================================================================
// 1. Root Account Activity
// ==========================================================================

describe('Root Account Activity', () => {
  it('should alert when userIdentity.type is Root', async () => {
    const evaluators = buildRegistry(rootActivityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Root Activity Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.root_activity',
      config: { excludeEventNames: [], includeFailedActions: true },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'CreateUser',
      eventSource: 'iam.amazonaws.com',
      userIdentity: {
        type: 'Root',
        arn: 'arn:aws:iam::123456789012:root',
        accountId: '123456789012',
        principalId: '123456789012',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.iam.CreateUser',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
    expect(result.candidates[0].severity).toBe('critical');
  });

  it('should NOT alert when userIdentity.type is IAMUser', async () => {
    const evaluators = buildRegistry(rootActivityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Root Activity Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.root_activity',
      config: { excludeEventNames: [], includeFailedActions: true },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'CreateUser',
      eventSource: 'iam.amazonaws.com',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/testuser',
        accountId: '123456789012',
        principalId: 'AIDAEXAMPLE',
        userName: 'testuser',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.iam.CreateUser',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 2. Root Activity with Exclusion
// ==========================================================================

describe('Root Activity with Exclusion', () => {
  it('should NOT alert when eventName is in excludeEventNames', async () => {
    const evaluators = buildRegistry(rootActivityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Root Activity with Exclusions',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.root_activity',
      config: { excludeEventNames: ['GetBillingDetails'], includeFailedActions: true },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'GetBillingDetails',
      eventSource: 'billing.amazonaws.com',
      userIdentity: {
        type: 'Root',
        arn: 'arn:aws:iam::123456789012:root',
        accountId: '123456789012',
        principalId: '123456789012',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.cloudtrail.event',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should alert when eventName is NOT in excludeEventNames', async () => {
    const evaluators = buildRegistry(rootActivityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Root Activity with Exclusions',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.root_activity',
      config: { excludeEventNames: ['GetBillingDetails'], includeFailedActions: true },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'CreateAccessKey',
      eventSource: 'iam.amazonaws.com',
      userIdentity: {
        type: 'Root',
        arn: 'arn:aws:iam::123456789012:root',
        accountId: '123456789012',
        principalId: '123456789012',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.iam.CreateAccessKey',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });
});

// ==========================================================================
// 3. Console Login Failure
// ==========================================================================

describe('Console Login Failure', () => {
  it('should alert on ConsoleLogin with errorMessage (failed login)', async () => {
    const evaluators = buildRegistry(authFailureEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Console Login Failure Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.auth_failure',
      config: { alertOnLoginFailure: true, alertOnRootLogin: false, alertOnNoMfa: false },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'ConsoleLogin',
      eventSource: 'signin.amazonaws.com',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/attacker',
        accountId: '123456789012',
        principalId: 'AIDAEXAMPLE',
        userName: 'attacker',
      },
      responseElements: { ConsoleLogin: 'Failure' },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.signin.ConsoleLogin',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert on a successful ConsoleLogin by IAM user', async () => {
    const evaluators = buildRegistry(authFailureEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Console Login Failure Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.auth_failure',
      config: { alertOnLoginFailure: true, alertOnRootLogin: false, alertOnNoMfa: false },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'ConsoleLogin',
      eventSource: 'signin.amazonaws.com',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/normaluser',
        accountId: '123456789012',
        principalId: 'AIDANORMAL',
        userName: 'normaluser',
      },
      responseElements: { ConsoleLogin: 'Success' },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.signin.ConsoleLogin',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 4. Root Console Login
// ==========================================================================

describe('Root Console Login', () => {
  it('should alert on ConsoleLogin with userIdentity.type Root', async () => {
    const evaluators = buildRegistry(authFailureEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Root Console Login Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.auth_failure',
      config: { alertOnLoginFailure: false, alertOnRootLogin: true, alertOnNoMfa: false },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'ConsoleLogin',
      eventSource: 'signin.amazonaws.com',
      userIdentity: {
        type: 'Root',
        arn: 'arn:aws:iam::123456789012:root',
        accountId: '123456789012',
        principalId: '123456789012',
      },
      responseElements: { ConsoleLogin: 'Success' },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.signin.ConsoleLogin',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
    expect(result.candidates[0].severity).toBe('critical');
  });
});

// ==========================================================================
// 5. CloudTrail Tampering
// ==========================================================================

describe('CloudTrail Tampering', () => {
  it('should alert on StopLogging from cloudtrail.amazonaws.com', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'CloudTrail Tampering Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.event_match',
      config: {
        eventNames: ['StopLogging', 'DeleteTrail'],
        eventSources: ['cloudtrail.amazonaws.com'],
        alertTitle: 'CloudTrail tampered: {{eventName}} by {{principalId}}',
      },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'StopLogging',
      eventSource: 'cloudtrail.amazonaws.com',
      userIdentity: {
        type: 'AssumedRole',
        arn: 'arn:aws:sts::123456789012:assumed-role/AdminRole/session',
        accountId: '123456789012',
        principalId: 'AROAEXAMPLE:session',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.cloudtrail.StopLogging',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert on StopLogging from a different eventSource', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'CloudTrail Tampering Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.event_match',
      config: {
        eventNames: ['StopLogging', 'DeleteTrail'],
        eventSources: ['cloudtrail.amazonaws.com'],
        alertTitle: 'CloudTrail tampered: {{eventName}} by {{principalId}}',
      },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'StopLogging',
      eventSource: 'ec2.amazonaws.com', // wrong source
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/testuser',
        accountId: '123456789012',
        principalId: 'AIDAEXAMPLE',
        userName: 'testuser',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.cloudtrail.StopLogging',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 6. IAM Privilege Escalation
// ==========================================================================

describe('IAM Privilege Escalation', () => {
  it('should alert on AttachUserPolicy (in eventNames list)', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'IAM Privilege Escalation',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.event_match',
      config: {
        eventNames: ['AttachUserPolicy', 'PutRolePolicy'],
        alertTitle: 'IAM privilege change: {{eventName}} by {{principalId}}',
      },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'AttachUserPolicy',
      eventSource: 'iam.amazonaws.com',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/suspect',
        accountId: '123456789012',
        principalId: 'AIDASUSPECT',
        userName: 'suspect',
      },
      requestParameters: {
        policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess',
        userName: 'target-user',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.iam.AttachUserPolicy',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert on DeleteUser (not in eventNames list)', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'IAM Privilege Escalation',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.event_match',
      config: {
        eventNames: ['AttachUserPolicy', 'PutRolePolicy'],
        alertTitle: 'IAM privilege change: {{eventName}} by {{principalId}}',
      },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'DeleteUser',
      eventSource: 'iam.amazonaws.com',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/admin',
        accountId: '123456789012',
        principalId: 'AIDAADMIN',
        userName: 'admin',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.iam.DeleteUser',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 7. Access Denied Monitor
// ==========================================================================

describe('Access Denied Monitor', () => {
  it('should alert when errorCode matches (AccessDenied)', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Access Denied Monitor',
      severity: 'medium',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.event_match',
      config: {
        errorEventsOnly: true,
        errorCodes: ['AccessDenied', 'UnauthorizedOperation'],
        alertTitle: 'Access denied: {{eventName}} by {{principalId}} in {{awsRegion}}',
      },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'ListBuckets',
      eventSource: 's3.amazonaws.com',
      errorCode: 'AccessDenied',
      errorMessage: 'Access Denied',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/lowpriv',
        accountId: '123456789012',
        principalId: 'AIDALOWPRIV',
        userName: 'lowpriv',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.s3.ListBuckets',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert on successful event (no errorCode)', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'Access Denied Monitor',
      severity: 'medium',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.event_match',
      config: {
        errorEventsOnly: true,
        errorCodes: ['AccessDenied', 'UnauthorizedOperation'],
        alertTitle: 'Access denied: {{eventName}} by {{principalId}} in {{awsRegion}}',
      },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'ListBuckets',
      eventSource: 's3.amazonaws.com',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/normaluser',
        accountId: '123456789012',
        principalId: 'AIDANORMAL',
        userName: 'normaluser',
      },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.s3.ListBuckets',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 8. Login Without MFA
// ==========================================================================

describe('Login Without MFA', () => {
  it('should alert when MFAUsed is No', async () => {
    const evaluators = buildRegistry(authFailureEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'No MFA Login Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.auth_failure',
      config: { alertOnLoginFailure: false, alertOnRootLogin: false, alertOnNoMfa: true },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'ConsoleLogin',
      eventSource: 'signin.amazonaws.com',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/nomfa-user',
        accountId: '123456789012',
        principalId: 'AIDANOMFA',
        userName: 'nomfa-user',
      },
      responseElements: { ConsoleLogin: 'Success' },
      additionalEventData: { MFAUsed: 'No' },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.signin.ConsoleLogin',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert when MFAUsed is Yes', async () => {
    const evaluators = buildRegistry(authFailureEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      name: 'No MFA Login Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.auth_failure',
      config: { alertOnLoginFailure: false, alertOnRootLogin: false, alertOnNoMfa: true },
      action: 'alert',
    });

    const payload = awsPayload({
      eventName: 'ConsoleLogin',
      eventSource: 'signin.amazonaws.com',
      userIdentity: {
        type: 'IAMUser',
        arn: 'arn:aws:iam::123456789012:user/mfa-user',
        accountId: '123456789012',
        principalId: 'AIDAMFA',
        userName: 'mfa-user',
      },
      responseElements: { ConsoleLogin: 'Success' },
      additionalEventData: { MFAUsed: 'Yes' },
    });
    const evt = await createTestEvent(org.id, {
      moduleId: 'aws',
      eventType: 'aws.signin.ConsoleLogin',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});
