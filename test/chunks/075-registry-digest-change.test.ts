/**
 * Chunk 075 — Evaluator: digest_change (tagPatterns, changeTypes filtering)
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
import { digestChangeEvaluator } from '../../modules/registry/src/evaluators/digest-change.js';

function makeDigestEvent(
  orgId: string,
  eventType: string,
  tag: string,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'registry',
    eventType,
    externalId: null,
    payload: {
      artifact: 'myorg/myimage',
      tag,
      eventType,
      oldDigest: 'sha256:aaaaaaaabbbbbbbb',
      newDigest: 'sha256:ccccccccdddddddd',
      source: 'poll',
      pusher: null,
    },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('Chunk 075 — digest_change evaluator', () => {
  let db: any;
  let redis: any;
  const evaluators = new Map([['registry:registry.digest_change', digestChangeEvaluator]]);

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert on digest change for a watched tag', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'registry' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'registry',
      ruleType: 'registry.digest_change',
      config: {
        tagPatterns: ['latest', 'v*'],
        changeTypes: ['digest_change'],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeDigestEvent(org.id, 'registry.docker.digest_change', 'latest'),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toContain('Digest changed');
  });

  it('should not alert for a tag that does not match tagPatterns', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'registry' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'registry',
      ruleType: 'registry.digest_change',
      config: {
        tagPatterns: ['v*'],
        changeTypes: ['digest_change'],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeDigestEvent(org.id, 'registry.docker.digest_change', 'nightly-20240101'),
    );

    expect(result.candidates).toHaveLength(0);
  });

  it('should not alert for a change type not in changeTypes config', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'registry' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'registry',
      ruleType: 'registry.digest_change',
      config: {
        tagPatterns: ['*'],
        changeTypes: ['new_tag'], // only watch new_tag, not digest_change
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeDigestEvent(org.id, 'registry.docker.digest_change', 'latest'),
    );

    expect(result.candidates).toHaveLength(0);
  });

  it('should alert on new_tag for npm artifacts', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'registry' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'registry',
      ruleType: 'registry.digest_change',
      config: {
        tagPatterns: ['*'],
        changeTypes: ['new_tag'],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeDigestEvent(org.id, 'registry.npm.new_tag', 'beta'),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toContain('New tag');
  });
});
