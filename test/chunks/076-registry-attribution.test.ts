/**
 * Chunk 076 — Evaluator: attribution (must_match, workflows/actors/branches allowlists)
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
import { attributionEvaluator } from '../../modules/registry/src/evaluators/attribution.js';

function makeAttributionEvent(
  orgId: string,
  attribution: Record<string, unknown> | null,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'registry',
    eventType: 'registry.docker.digest_change',
    externalId: null,
    payload: {
      artifact: 'myorg/myimage',
      tag: 'latest',
      eventType: 'registry.docker.digest_change',
      newDigest: 'sha256:aabbccdd',
      source: 'poll',
      attribution,
    },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('Chunk 076 — attribution evaluator', () => {
  let db: any;
  let redis: any;
  const evaluators = new Map([['registry:registry.attribution', attributionEvaluator]]);

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert when actor is not in the allowlist (must_match)', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'registry' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'registry',
      ruleType: 'registry.attribution',
      config: {
        tagPatterns: ['*'],
        changeTypes: ['digest_change'],
        attributionCondition: 'must_match',
        actors: ['github-actions[bot]', 'deploy-bot'],
        workflows: [],
        branches: [],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeAttributionEvent(org.id, {
        status: 'verified',
        workflow: '.github/workflows/deploy.yml',
        actor: 'random-human', // not in allowlist
        branch: 'main',
        runId: 12345,
        commit: 'abc123',
      }),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toContain('Unattributed');
  });

  it('should pass when actor is in the allowlist (must_match)', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'registry' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'registry',
      ruleType: 'registry.attribution',
      config: {
        tagPatterns: ['*'],
        changeTypes: ['digest_change'],
        attributionCondition: 'must_match',
        actors: ['deploy-bot'],
        workflows: [],
        branches: [],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeAttributionEvent(org.id, {
        status: 'verified',
        workflow: '.github/workflows/deploy.yml',
        actor: 'deploy-bot',
        branch: 'main',
        runId: 12345,
        commit: 'abc123',
      }),
    );

    expect(result.candidates).toHaveLength(0);
  });

  it('should alert when workflow is not in the allowlist (must_match)', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'registry' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'registry',
      ruleType: 'registry.attribution',
      config: {
        tagPatterns: ['*'],
        changeTypes: ['digest_change'],
        attributionCondition: 'must_match',
        workflows: ['deploy.yml'],
        actors: [],
        branches: [],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeAttributionEvent(org.id, {
        status: 'verified',
        workflow: '.github/workflows/evil-build.yml',
        actor: 'deploy-bot',
        branch: 'main',
        runId: 99999,
        commit: 'def456',
      }),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.description).toContain('workflow');
  });

  it('should alert when attribution is completely absent (must_match)', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'registry' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'registry',
      ruleType: 'registry.attribution',
      config: {
        tagPatterns: ['*'],
        changeTypes: ['digest_change'],
        attributionCondition: 'must_match',
        workflows: [],
        actors: [],
        branches: [],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(makeAttributionEvent(org.id, null));

    expect(result.candidates).toHaveLength(1);
  });
});
