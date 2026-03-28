/**
 * Chunk 068 — Evaluator: force_push (watchBranches glob filtering)
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
import { forcePushEvaluator } from '../../modules/github/src/evaluators/force-push.js';

function makePushEvent(
  orgId: string,
  branch: string,
  forced: boolean,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'github',
    eventType: 'github.push',
    externalId: null,
    payload: {
      ref: `refs/heads/${branch}`,
      forced,
      repository: { full_name: 'acme/backend' },
      pusher: { name: 'dev-user' },
      sender: { login: 'dev-user' },
      commits_count: 3,
      head_commit: { id: 'abc123', message: 'force push fix' },
    },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('Chunk 068 — force_push evaluator', () => {
  let db: any;
  let redis: any;
  const evaluators = new Map([['github:github.force_push', forcePushEvaluator]]);

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert on force push to main', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: {
        watchBranches: ['main', 'master', 'release/*'],
        alertOnAllForced: false,
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(makePushEvent(org.id, 'main', true));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toContain('Force push to main');
    expect(result.candidates[0]!.severity).toBeDefined();
  });

  it('should not alert on force push to a non-watched branch', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: {
        watchBranches: ['main', 'master'],
        alertOnAllForced: false,
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(makePushEvent(org.id, 'feature/my-branch', true));

    expect(result.candidates).toHaveLength(0);
  });

  it('should not alert on non-forced push to main', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: {
        watchBranches: ['main'],
        alertOnAllForced: false,
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(makePushEvent(org.id, 'main', false));

    expect(result.candidates).toHaveLength(0);
  });

  it('should match release/* glob pattern', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: {
        watchBranches: ['release/*'],
        alertOnAllForced: false,
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(makePushEvent(org.id, 'release/v2.1', true));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toContain('release/v2.1');
  });

  it('should skip tag pushes', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: { watchBranches: ['*'], alertOnAllForced: true },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(makePushEvent(org.id, 'v1.0.0', true, {
      payload: {
        ref: 'refs/tags/v1.0.0',
        forced: true,
        repository: { full_name: 'acme/backend' },
        pusher: { name: 'dev-user' },
        sender: { login: 'dev-user' },
        commits_count: 1,
        head_commit: null,
      },
    }));

    expect(result.candidates).toHaveLength(0);
  });
});
