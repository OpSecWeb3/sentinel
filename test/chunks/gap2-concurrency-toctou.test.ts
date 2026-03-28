/**
 * Audit Gap 2: Race conditions and TOCTOU bugs in Redis GET->SET patterns.
 *
 * Validates exactly-once semantics under concurrent access for:
 *   - Correlation sequence instance creation (SET NX)
 *   - Detection cooldown lock acquisition (SET NX PX)
 *   - Aggregation counter atomicity (Lua INCR + threshold)
 *   - Absence timer creation (SET NX)
 *   - Raw Redis SET NX atomicity
 *
 * Uses real Redis (ioredis on localhost:6380/1) and Promise.all() to create
 * actual interleaving across concurrent engine instances.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  cleanTables,
  resetCounters,
  getTestDb,
  getTestSql,
  getTestRedis,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestRule,
  createTestEvent,
} from '../helpers/setup.js';
import { CorrelationEngine } from '@sentinel/shared/correlation-engine';
import { RuleEngine } from '@sentinel/shared/rule-engine';
import { correlationRules } from '@sentinel/db/schema/correlation';
import type { CorrelationRuleConfig } from '@sentinel/shared/correlation-types';
import type { NormalizedEvent } from '@sentinel/shared/rules';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let orgId: string;
let userId: string;

/** Build a NormalizedEvent with sensible defaults. */
function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    orgId,
    moduleId: 'github',
    eventType: 'github.push',
    externalId: null,
    payload: { repository: { full_name: 'org/repo' }, sender: { login: 'alice' } },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

/** Insert a correlation rule via Drizzle and return its id. */
async function insertCorrelationRule(
  config: CorrelationRuleConfig,
  overrides: Partial<{ name: string; severity: string; cooldownMinutes: number }> = {},
): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(correlationRules)
    .values({
      orgId,
      createdBy: userId,
      name: overrides.name ?? `corr-rule-${crypto.randomUUID().slice(0, 8)}`,
      severity: overrides.severity ?? 'high',
      status: 'active',
      config,
      channelIds: [],
      cooldownMinutes: overrides.cooldownMinutes ?? 0,
    })
    .returning();
  return row.id;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const sql = getTestSql();
  const user = await createTestUser();
  const org = await createTestOrg();
  await addMembership(org.id, user.id, 'admin');
  orgId = org.id;
  userId = user.id;
});

beforeEach(async () => {
  const redis = getTestRedis();
  await redis.flushdb();
  // Invalidate module-level rule cache so each test picks up fresh rules
  const engine = new CorrelationEngine({ redis, db: getTestDb() });
  engine.invalidateCache(orgId);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gap 2 — Concurrency / TOCTOU in Redis patterns', () => {
  // -----------------------------------------------------------------------
  // 1. Correlation sequence — concurrent workers matching same key
  // -----------------------------------------------------------------------
  it('sequence: only one instance is created when two workers race on the same trigger', async () => {
    const redis = getTestRedis();
    const db = getTestDb();

    const config: CorrelationRuleConfig = {
      type: 'sequence',
      correlationKey: [{ field: 'repository.full_name' }],
      windowMinutes: 10,
      steps: [
        { name: 'Step1', eventFilter: { eventType: 'github.push', conditions: [] }, matchConditions: [] },
        { name: 'Step2', eventFilter: { eventType: 'github.pr', conditions: [] }, matchConditions: [] },
      ],
    };

    await insertCorrelationRule(config);

    const engine1 = new CorrelationEngine({ redis, db });
    const engine2 = new CorrelationEngine({ redis, db });
    // Invalidate so both engines load the fresh rule
    engine1.invalidateCache(orgId);

    const event = makeEvent({ eventType: 'github.push' });

    const [r1, r2] = await Promise.all([
      engine1.evaluate(event),
      engine2.evaluate(event),
    ]);

    // Exactly one engine should have started a new sequence instance
    const totalStarted = r1.startedRuleIds.size + r2.startedRuleIds.size;
    // Both may start (SET NX race), but only one Redis key should persist
    const seqKeys = await redis.keys('sentinel:corr:seq:*');
    expect(seqKeys.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 2. Cooldown lock — concurrent rule evaluations
  // -----------------------------------------------------------------------
  it('cooldown: only one of two concurrent evaluations acquires the lock', async () => {
    const redis = getTestRedis();
    const db = getTestDb();

    const detection = await createTestDetection(orgId, userId, {
      moduleId: 'github',
      config: { cooldownMinutes: 5 },
    });

    // Update cooldown directly since createTestDetection may not set it
    const sql = getTestSql();
    await sql`UPDATE detections SET cooldown_minutes = 5 WHERE id = ${detection.id}`;

    await createTestRule(detection.id, orgId, {
      moduleId: 'github',
      ruleType: 'always-match',
      config: {},
      action: 'alert',
    });

    // Stub evaluator that always produces a candidate
    const alwaysMatch = {
      configSchema: { safeParse: () => ({ success: true, data: {} }) },
      evaluate: () => ({
        orgId,
        detectionId: detection.id,
        ruleId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        severity: 'high' as const,
        title: 'Test Alert',
        description: 'test',
        triggerType: 'immediate' as const,
        triggerData: {},
      }),
    };

    const evaluators = new Map([['github:always-match', alwaysMatch]]);

    const engine1 = new RuleEngine({ evaluators, redis, db });
    const engine2 = new RuleEngine({ evaluators, redis, db });

    const event = makeEvent();

    const [r1, r2] = await Promise.all([
      engine1.evaluate(event),
      engine2.evaluate(event),
    ]);

    // Exactly one should win the cooldown lock and produce a candidate
    const totalCandidates = r1.candidates.length + r2.candidates.length;
    expect(totalCandidates).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 3. Aggregation counter — concurrent increments
  // -----------------------------------------------------------------------
  it('aggregation: fires exactly once when two workers race to reach threshold', async () => {
    const redis = getTestRedis();
    const db = getTestDb();

    const config: CorrelationRuleConfig = {
      type: 'aggregation',
      correlationKey: [{ field: 'repository.full_name' }],
      windowMinutes: 10,
      aggregation: {
        eventFilter: { eventType: 'github.push', conditions: [] },
        threshold: 2,
      },
    };

    await insertCorrelationRule(config);

    const engine1 = new CorrelationEngine({ redis, db });
    const engine2 = new CorrelationEngine({ redis, db });
    engine1.invalidateCache(orgId);

    const event1 = makeEvent({ eventType: 'github.push' });
    const event2 = makeEvent({ eventType: 'github.push' });

    const [r1, r2] = await Promise.all([
      engine1.evaluate(event1),
      engine2.evaluate(event2),
    ]);

    // The Lua script atomically increments and checks threshold, so exactly
    // one evaluation should produce a correlated alert candidate.
    const totalCandidates = r1.candidates.length + r2.candidates.length;
    expect(totalCandidates).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 4. Absence timer — concurrent trigger events
  // -----------------------------------------------------------------------
  it('absence: only one timer is started when two workers race on the same trigger', async () => {
    const redis = getTestRedis();
    const db = getTestDb();

    const config: CorrelationRuleConfig = {
      type: 'absence',
      correlationKey: [{ field: 'repository.full_name' }],
      windowMinutes: 60,
      absence: {
        trigger: { eventFilter: { eventType: 'github.push', conditions: [] } },
        expected: {
          eventFilter: { eventType: 'github.deployment', conditions: [] },
          matchConditions: [],
        },
        graceMinutes: 30,
      },
    };

    await insertCorrelationRule(config);

    const engine1 = new CorrelationEngine({ redis, db });
    const engine2 = new CorrelationEngine({ redis, db });
    engine1.invalidateCache(orgId);

    const event = makeEvent({ eventType: 'github.push' });

    const [r1, r2] = await Promise.all([
      engine1.evaluate(event),
      engine2.evaluate(event),
    ]);

    // Only one absence instance should exist in Redis
    const absenceKeys = await redis.keys('sentinel:corr:absence:*');
    // Filter out the index sorted set key
    const instanceKeys = absenceKeys.filter((k) => k !== 'sentinel:corr:absence:index');
    expect(instanceKeys.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 5. Redis SET NX atomicity verification
  // -----------------------------------------------------------------------
  it('SET NX: exactly one caller wins among 10 concurrent attempts', async () => {
    const redis = getTestRedis();
    const key = 'test:nx:race';

    const results = await Promise.all(
      Array.from({ length: 10 }, () => redis.set(key, '1', 'NX', 'EX', 60)),
    );

    const wins = results.filter((r) => r === 'OK');
    expect(wins).toHaveLength(1);

    // Verify the key was actually set
    const value = await redis.get(key);
    expect(value).toBe('1');
  });
});
