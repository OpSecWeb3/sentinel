/**
 * Chunk 067 — Evaluator: secret_scanning (secretTypes filtering)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestDb,
  getTestRedis,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestRule,
} from '../helpers/setup.js';
import { RuleEngine } from '@sentinel/shared/rule-engine';
import type { NormalizedEvent } from '@sentinel/shared/rules';
import { secretScanningEvaluator } from '../../modules/github/src/evaluators/secret-scanning.js';

function makeSecretScanEvent(
  orgId: string,
  secretType: string,
  action = 'created',
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'github',
    eventType: `github.secret_scanning.${action}`,
    externalId: null,
    payload: {
      action,
      alert: { number: 42, secret_type: secretType, state: 'open' },
      repository: { full_name: 'acme/web-app' },
      sender: { login: 'dependabot' },
    },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('Chunk 067 — secret_scanning evaluator', () => {
  let db: any;
  let redis: any;
  const evaluators = new Map([['github:github.secret_scanning', secretScanningEvaluator]]);

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert when a secret is detected matching allowed type', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.secret_scanning',
      config: {
        alertOnActions: ['created'],
        secretTypes: ['aws_access_key_id', 'github_personal_access_token'],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeSecretScanEvent(org.id, 'aws_access_key_id'),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toContain('Secret scanning alert');
    expect(result.candidates[0]!.description).toContain('aws_access_key_id');
  });

  it('should not alert when secret type is not in the filter list', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.secret_scanning',
      config: {
        alertOnActions: ['created'],
        secretTypes: ['aws_access_key_id'], // only watching AWS keys
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeSecretScanEvent(org.id, 'slack_incoming_webhook'), // not in filter
    );

    expect(result.candidates).toHaveLength(0);
  });

  it('should alert on all secret types when secretTypes is empty', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.secret_scanning',
      config: {
        alertOnActions: ['created'],
        secretTypes: [], // empty means all types
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeSecretScanEvent(org.id, 'some_random_secret_type'),
    );

    expect(result.candidates).toHaveLength(1);
  });

  it('should not alert for an action not in alertOnActions', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.secret_scanning',
      config: {
        alertOnActions: ['resolved'], // only resolved
        secretTypes: [],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeSecretScanEvent(org.id, 'aws_access_key_id', 'created'),
    );

    expect(result.candidates).toHaveLength(0);
  });
});
