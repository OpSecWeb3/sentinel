/**
 * Chunk 043 — Rule Engine: Host scope filtering (detection.config.hostScope glob patterns)
 * Chunk 044 — Rule Engine: Resource filter (rule.config.resourceFilter include/exclude globs)
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
import { z } from 'zod';

function makeEvent(orgId: string, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'infra',
    eventType: 'infra.cert_expiry',
    externalId: null,
    payload: { host: 'example.com', daysRemaining: 10 },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

// A simple evaluator that always matches and returns a proper AlertCandidate
const alwaysMatchEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.cert_expiry',
  configSchema: z.object({}).passthrough(),
  evaluate: (ctx: any) => ({
    orgId: ctx.event.orgId,
    detectionId: ctx.rule.detectionId,
    ruleId: ctx.rule.id,
    eventId: ctx.event.id,
    severity: 'high',
    title: 'Matched',
    description: 'test',
    triggerType: 'immediate',
    triggerData: {},
  }),
};

describe('Chunk 043 — Host scope filtering', () => {
  let db: any;
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should pass all events when hostScope is not set', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      config: {}, // no hostScope
    });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.cert_expiry',
      config: { daysThreshold: 30 },
    });

    const evaluators = new Map([['infra:infra.cert_expiry', alwaysMatchEvaluator]]);
    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeEvent(org.id, {
      payload: { host: 'anything.com', daysRemaining: 10, resourceId: 'anything.com' },
    }));

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('should filter events by hostScope glob pattern', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      config: { hostScope: ['*.prod.example.com'] },
    });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.cert_expiry',
      config: { daysThreshold: 30 },
    });

    const evaluators = new Map([['infra:infra.cert_expiry', alwaysMatchEvaluator]]);
    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    // Event with matching host
    const matchResult = await engine.evaluate(makeEvent(org.id, {
      payload: {
        host: 'api.prod.example.com',
        daysRemaining: 10,
        resourceId: 'api.prod.example.com',
      },
    }));

    // Event with non-matching host
    const noMatchResult = await engine.evaluate(makeEvent(org.id, {
      payload: {
        host: 'api.staging.example.com',
        daysRemaining: 10,
        resourceId: 'api.staging.example.com',
      },
    }));

    expect(matchResult.candidates.length).toBeGreaterThanOrEqual(1);
    expect(noMatchResult.candidates.length).toBe(0);
  });

  it('should support multiple hostScope patterns (OR semantics)', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      config: { hostScope: ['*.prod.*', '*.staging.*'] },
    });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.cert_expiry',
      config: { daysThreshold: 30 },
    });

    const evaluators = new Map([['infra:infra.cert_expiry', alwaysMatchEvaluator]]);
    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const stagingResult = await engine.evaluate(makeEvent(org.id, {
      payload: { host: 'api.staging.example.com', resourceId: 'api.staging.example.com' },
    }));

    expect(stagingResult.candidates.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Chunk 044 — Resource filter (include/exclude globs)', () => {
  let db: any;
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should pass all events when resourceFilter is not set', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' }, // no resourceFilter
    });

    const evaluators = new Map([['github:github.repo_visibility', alwaysMatchEvaluator]]);
    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      payload: { repository: { full_name: 'org/any-repo' }, resourceId: 'org/any-repo' },
    }));

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('should include only matching resources', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: {
        alertOn: 'publicized',
        resourceFilter: { include: ['org/prod-*'] },
      },
    });

    const evaluators = new Map([['github:github.repo_visibility', alwaysMatchEvaluator]]);
    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const matchResult = await engine.evaluate(makeEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      payload: { repository: { full_name: 'org/prod-api' }, resourceId: 'org/prod-api' },
    }));

    const noMatchResult = await engine.evaluate(makeEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      payload: { repository: { full_name: 'org/dev-api' }, resourceId: 'org/dev-api' },
    }));

    expect(matchResult.candidates.length).toBeGreaterThanOrEqual(1);
    expect(noMatchResult.candidates.length).toBe(0);
  });

  it('should exclude matching resources', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: {
        alertOn: 'publicized',
        resourceFilter: { exclude: ['org/test-*'] },
      },
    });

    const evaluators = new Map([['github:github.repo_visibility', alwaysMatchEvaluator]]);
    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const excludedResult = await engine.evaluate(makeEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      payload: { repository: { full_name: 'org/test-repo' }, resourceId: 'org/test-repo' },
    }));

    const passedResult = await engine.evaluate(makeEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      payload: { repository: { full_name: 'org/prod-repo' }, resourceId: 'org/prod-repo' },
    }));

    expect(excludedResult.candidates.length).toBe(0);
    expect(passedResult.candidates.length).toBeGreaterThanOrEqual(1);
  });
});
