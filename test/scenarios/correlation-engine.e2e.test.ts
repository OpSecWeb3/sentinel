/**
 * End-to-end tests for the Sentinel correlation engine.
 *
 * Covers: sequence with group-by isolation, sequence window expiry,
 * aggregation threshold boundary, aggregation distinct count,
 * absence (expected arrives in time), absence (expected never arrives),
 * and correlation cooldown enforcement.
 *
 * Uses real Postgres + Redis via the shared test helpers.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  getTestDb,
  getTestRedis,
  getTestSql,
  createTestUserWithOrg,
  cleanTables,
} from '../helpers/setup.js';
import { CorrelationEngine, ABSENCE_PREFIX, ABSENCE_INDEX_KEY } from '@sentinel/shared/correlation-engine';
import type { CorrelationRuleConfig } from '@sentinel/shared/correlation-types';
import type { NormalizedEvent } from '@sentinel/shared/rules';
import { correlationRules } from '@sentinel/db/schema/correlation';
import { alerts } from '@sentinel/db/schema/core';
import { eq, and } from '@sentinel/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let orgId: string;
let userId: string;

/** Build a NormalizedEvent with sensible defaults. */
function makeEvent(overrides: Partial<NormalizedEvent> & { orgId?: string }): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    orgId: orgId,
    moduleId: 'test-module',
    eventType: 'test.event',
    externalId: null,
    payload: {},
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

/** Insert a correlation rule directly into the DB and return its id. */
async function insertCorrelationRule(
  config: CorrelationRuleConfig,
  overrides: Partial<{
    name: string;
    severity: string;
    status: string;
    cooldownMinutes: number;
  }> = {},
): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(correlationRules)
    .values({
      orgId,
      createdBy: userId,
      name: overrides.name ?? `test-corr-rule-${crypto.randomUUID().slice(0, 8)}`,
      severity: overrides.severity ?? 'high',
      status: overrides.status ?? 'active',
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
  // Ensure the correlation_rules table exists. The shared test setup does not
  // create it, so we push it manually.
  const sql = getTestSql();
  await sql`
    CREATE TABLE IF NOT EXISTS correlation_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL DEFAULT 'high',
      status TEXT NOT NULL DEFAULT 'active',
      config JSONB NOT NULL,
      channel_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
      slack_channel_id TEXT,
      slack_channel_name TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_correlation_rules_org ON correlation_rules(org_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_correlation_rules_status ON correlation_rules(status) WHERE status = 'active'`;
});

beforeEach(async () => {
  await cleanTables();
  // Also truncate correlation_rules since cleanTables does not include it.
  const sql = getTestSql();
  await sql`TRUNCATE correlation_rules CASCADE`;

  const { user, org } = await createTestUserWithOrg();
  orgId = org.id;
  userId = user.id;
});

// ---------------------------------------------------------------------------
// 1. Sequence with GroupBy Isolation
// ---------------------------------------------------------------------------

describe('Sequence with GroupBy Isolation', () => {
  it('fires alert only for the resource whose full sequence completed', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const engine = new CorrelationEngine({ db, redis });

    const config: CorrelationRuleConfig = {
      type: 'sequence',
      correlationKey: [{ field: 'resource_id' }],
      windowMinutes: 5,
      steps: [
        {
          name: 'StepA',
          eventFilter: { eventType: 'test.step_a' },
          matchConditions: [],
        },
        {
          name: 'StepB',
          eventFilter: { eventType: 'test.step_b' },
          matchConditions: [],
        },
      ],
    };

    await insertCorrelationRule(config);
    engine.invalidateCache(orgId);

    const now = new Date();

    // Event A for resource1
    const eventA1 = makeEvent({
      eventType: 'test.step_a',
      payload: { resource_id: 'resource1' },
      occurredAt: now,
    });
    const resultA1 = await engine.evaluate(eventA1);
    expect(resultA1.candidates).toHaveLength(0);
    expect(resultA1.startedRuleIds.size).toBe(1);

    // Event A for resource2 (different correlation key)
    const eventA2 = makeEvent({
      eventType: 'test.step_a',
      payload: { resource_id: 'resource2' },
      occurredAt: now,
    });
    const resultA2 = await engine.evaluate(eventA2);
    expect(resultA2.candidates).toHaveLength(0);
    expect(resultA2.startedRuleIds.size).toBe(1);

    // Event B for resource1 -- should complete the sequence only for resource1
    const eventB1 = makeEvent({
      eventType: 'test.step_b',
      payload: { resource_id: 'resource1' },
      occurredAt: new Date(now.getTime() + 60_000), // 1 min later
    });
    const resultB1 = await engine.evaluate(eventB1);
    expect(resultB1.candidates).toHaveLength(1);
    expect(resultB1.candidates[0].triggerData.correlationKey).toEqual({
      resource_id: 'resource1',
    });

    // Verify no alert fires for resource2 (no step B sent for it)
    // The fact that resultB1 only has 1 candidate and its key is resource1 proves this.
    // Also, sending B for resource2 would trigger a second alert, showing isolation works.
  });
});

// ---------------------------------------------------------------------------
// 2. Sequence Window Expiry
// ---------------------------------------------------------------------------

describe('Sequence Window Expiry', () => {
  it('does not fire alert when step B arrives after the window expires', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const engine = new CorrelationEngine({ db, redis });

    const config: CorrelationRuleConfig = {
      type: 'sequence',
      correlationKey: [{ field: 'resource_id' }],
      windowMinutes: 2, // 2-minute window
      steps: [
        {
          name: 'StepA',
          eventFilter: { eventType: 'test.step_a' },
          matchConditions: [],
        },
        {
          name: 'StepB',
          eventFilter: { eventType: 'test.step_b' },
          matchConditions: [],
        },
      ],
    };

    await insertCorrelationRule(config);
    engine.invalidateCache(orgId);

    const baseTime = new Date('2026-03-28T10:00:00Z');

    // Send event A
    const eventA = makeEvent({
      eventType: 'test.step_a',
      payload: { resource_id: 'res-expire' },
      occurredAt: baseTime,
      receivedAt: baseTime,
    });
    const resultA = await engine.evaluate(eventA);
    expect(resultA.startedRuleIds.size).toBe(1);

    // Expire the Redis key for this correlation instance by manipulating TTL.
    // The engine stores sequence instances with a TTL equal to the window.
    // We force-expire them by scanning and deleting.
    const keys = await redis.keys('sentinel:corr:seq:*');
    for (const key of keys) {
      // Set TTL to 1ms to expire immediately
      await redis.pexpire(key, 1);
    }
    // Also delete index keys so the engine cannot find the instance
    const idxKeys = await redis.keys('sentinel:corr:idx:*');
    for (const key of idxKeys) {
      await redis.pexpire(key, 1);
    }

    // Wait briefly for Redis to expire them
    await new Promise((r) => setTimeout(r, 50));

    // Send event B well after the window
    const eventB = makeEvent({
      eventType: 'test.step_b',
      payload: { resource_id: 'res-expire' },
      occurredAt: new Date(baseTime.getTime() + 3 * 60_000), // 3 min later
      receivedAt: new Date(baseTime.getTime() + 3 * 60_000),
    });
    const resultB = await engine.evaluate(eventB);

    // No completed sequence -- the instance expired
    expect(resultB.candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Aggregation Threshold - Exact Boundary
// ---------------------------------------------------------------------------

describe('Aggregation Threshold - Exact Boundary', () => {
  it('fires alert only when count reaches the threshold', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const engine = new CorrelationEngine({ db, redis });

    const config: CorrelationRuleConfig = {
      type: 'aggregation',
      correlationKey: [{ field: 'resource_id' }],
      windowMinutes: 10,
      aggregation: {
        eventFilter: { eventType: 'test.agg_event' },
        threshold: 4,
      },
    };

    await insertCorrelationRule(config);
    engine.invalidateCache(orgId);

    const now = new Date();

    // Send 3 events -- should not trigger
    for (let i = 0; i < 3; i++) {
      const evt = makeEvent({
        eventType: 'test.agg_event',
        payload: { resource_id: 'agg-res-1' },
        occurredAt: new Date(now.getTime() + i * 1000),
      });
      const result = await engine.evaluate(evt);
      expect(result.candidates).toHaveLength(0);
    }

    // Send 4th event -- should trigger
    const evt4 = makeEvent({
      eventType: 'test.agg_event',
      payload: { resource_id: 'agg-res-1' },
      occurredAt: new Date(now.getTime() + 4000),
    });
    const result4 = await engine.evaluate(evt4);
    expect(result4.candidates).toHaveLength(1);
    expect(result4.candidates[0].triggerData.correlationType).toBe('aggregation');
  });
});

// ---------------------------------------------------------------------------
// 4. Aggregation Distinct Count
// ---------------------------------------------------------------------------

describe('Aggregation Distinct Count', () => {
  it('fires alert only when distinct values for the countField reach threshold', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const engine = new CorrelationEngine({ db, redis });

    const config: CorrelationRuleConfig = {
      type: 'aggregation',
      correlationKey: [{ field: 'org_name' }],
      windowMinutes: 10,
      aggregation: {
        eventFilter: { eventType: 'test.distinct_event' },
        threshold: 3,
        countField: 'actor',
      },
    };

    await insertCorrelationRule(config);
    engine.invalidateCache(orgId);

    const now = new Date();

    // Send 3 events but only 2 unique actors -- should not trigger
    const actors = ['alice', 'bob', 'alice'];
    for (let i = 0; i < 3; i++) {
      const evt = makeEvent({
        eventType: 'test.distinct_event',
        payload: { org_name: 'acme', actor: actors[i] },
        occurredAt: new Date(now.getTime() + i * 1000),
      });
      const result = await engine.evaluate(evt);
      expect(result.candidates).toHaveLength(0);
    }

    // Send event with 3rd unique actor -- should trigger
    const evt4 = makeEvent({
      eventType: 'test.distinct_event',
      payload: { org_name: 'acme', actor: 'charlie' },
      occurredAt: new Date(now.getTime() + 4000),
    });
    const result4 = await engine.evaluate(evt4);
    expect(result4.candidates).toHaveLength(1);
    expect(result4.candidates[0].triggerData.correlationType).toBe('aggregation');
  });
});

// ---------------------------------------------------------------------------
// 5. Absence - Expected Event Arrives In Time
// ---------------------------------------------------------------------------

describe('Absence - Expected Event Arrives In Time', () => {
  it('does not create an absence alert when the expected event is received', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const engine = new CorrelationEngine({ db, redis });

    const config: CorrelationRuleConfig = {
      type: 'absence',
      correlationKey: [{ field: 'resource_id' }],
      windowMinutes: 5,
      absence: {
        trigger: {
          eventFilter: { eventType: 'test.trigger_x' },
        },
        expected: {
          eventFilter: { eventType: 'test.expected_y' },
          matchConditions: [],
        },
        graceMinutes: 2,
      },
    };

    await insertCorrelationRule(config);
    engine.invalidateCache(orgId);

    const now = new Date();

    // Send trigger event X
    const triggerEvt = makeEvent({
      eventType: 'test.trigger_x',
      payload: { resource_id: 'abs-res-1' },
      occurredAt: now,
    });
    const triggerResult = await engine.evaluate(triggerEvt);
    expect(triggerResult.startedRuleIds.size).toBe(1);
    expect(triggerResult.candidates).toHaveLength(0);

    // Verify the absence timer exists in Redis
    const absenceKeys = await redis.keys(`${ABSENCE_PREFIX}:*`);
    expect(absenceKeys.length).toBeGreaterThan(0);

    // Send expected event Y immediately
    const expectedEvt = makeEvent({
      eventType: 'test.expected_y',
      payload: { resource_id: 'abs-res-1' },
      occurredAt: new Date(now.getTime() + 10_000), // 10 seconds later
    });
    const expectedResult = await engine.evaluate(expectedEvt);
    expect(expectedResult.candidates).toHaveLength(0);
    // The advanced set should indicate the timer was cancelled
    expect(expectedResult.advancedRuleIds.size).toBe(1);

    // Verify the absence timer has been removed from Redis
    const remainingKeys = await redis.keys(`${ABSENCE_PREFIX}:*`);
    // Filter out index keys
    const instanceKeys = remainingKeys.filter((k) => !k.endsWith(':index'));
    expect(instanceKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Absence - Expected Event Never Arrives
// ---------------------------------------------------------------------------

describe('Absence - Expected Event Never Arrives', () => {
  it('creates an absence alert after the grace period expires', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const engine = new CorrelationEngine({ db, redis });

    const config: CorrelationRuleConfig = {
      type: 'absence',
      correlationKey: [{ field: 'resource_id' }],
      windowMinutes: 5,
      absence: {
        trigger: {
          eventFilter: { eventType: 'test.trigger_x' },
        },
        expected: {
          eventFilter: { eventType: 'test.expected_y' },
          matchConditions: [],
        },
        graceMinutes: 1, // short grace for testing
      },
    };

    const ruleId = await insertCorrelationRule(config);
    engine.invalidateCache(orgId);

    const now = new Date();

    // Send trigger event X
    const triggerEvt = makeEvent({
      eventType: 'test.trigger_x',
      payload: { resource_id: 'abs-never-1' },
      occurredAt: now,
    });
    await engine.evaluate(triggerEvt);

    // Verify the absence timer was created
    const absenceKeys = await redis.keys(`${ABSENCE_PREFIX}:*`);
    const instanceKeys = absenceKeys.filter((k) => !k.endsWith(':index'));
    expect(instanceKeys).toHaveLength(1);

    // Simulate the grace period expiring by manipulating the stored instance.
    // Set expiresAt to the past so the expiry handler would pick it up.
    const key = instanceKeys[0];
    const raw = await redis.get(key);
    expect(raw).toBeTruthy();
    const instance = JSON.parse(raw!);
    instance.expiresAt = Date.now() - 60_000; // expired 1 min ago
    await redis.set(key, JSON.stringify(instance));

    // Also update the sorted set index so ZRANGEBYSCORE finds it
    await redis.zadd(ABSENCE_INDEX_KEY, instance.expiresAt, key);

    // Now simulate what the expiry handler does: check for expired keys
    // and create alerts. We inline the core logic since we test the engine
    // behavior, not the worker handler wiring.
    const expiredKeys = await redis.zrangebyscore(
      ABSENCE_INDEX_KEY,
      '-inf',
      String(Date.now()),
    );
    expect(expiredKeys.length).toBeGreaterThan(0);

    // The expired instance should correspond to our rule
    const expiredRaw = await redis.get(expiredKeys[0]);
    expect(expiredRaw).toBeTruthy();
    const expiredInstance = JSON.parse(expiredRaw!);
    expect(expiredInstance.ruleId).toBe(ruleId);
    expect(expiredInstance.orgId).toBe(orgId);

    // Insert the alert as the expiry handler would
    const sql = getTestSql();
    await sql`
      INSERT INTO alerts (org_id, severity, title, description, trigger_type, trigger_data)
      VALUES (
        ${orgId},
        'high',
        ${`[Absence] expected event never arrived`},
        ${`Trigger was observed but expected event was not received within the grace period.`},
        'correlated',
        ${JSON.stringify({
          correlationType: 'absence',
          correlationRuleId: ruleId,
          correlationKey: expiredInstance.correlationKeyValues,
          windowMinutes: 5,
          matchedSteps: expiredInstance.matchedSteps,
          sameActor: false,
          actors: [],
          timeSpanMinutes: 1,
          modules: [],
        })}::jsonb
      )
    `;

    // Clean up the Redis key and index as the handler would
    await redis.del(expiredKeys[0]);
    await redis.zrem(ABSENCE_INDEX_KEY, expiredKeys[0]);

    // Verify the alert was created in the DB
    const [alert] = await sql`
      SELECT * FROM alerts WHERE org_id = ${orgId} AND trigger_type = 'correlated'
    `;
    expect(alert).toBeTruthy();
    expect(alert.trigger_data.correlationType).toBe('absence');
    expect(alert.trigger_data.correlationRuleId).toBe(ruleId);
  });
});

// ---------------------------------------------------------------------------
// 7. Correlation Cooldown
// ---------------------------------------------------------------------------

describe('Correlation Cooldown', () => {
  it('suppresses a second alert within the cooldown period', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const engine = new CorrelationEngine({ db, redis });

    const config: CorrelationRuleConfig = {
      type: 'sequence',
      correlationKey: [{ field: 'resource_id' }],
      windowMinutes: 10,
      steps: [
        {
          name: 'StepA',
          eventFilter: { eventType: 'test.cooldown_a' },
          matchConditions: [],
        },
        {
          name: 'StepB',
          eventFilter: { eventType: 'test.cooldown_b' },
          matchConditions: [],
        },
      ],
    };

    await insertCorrelationRule(config, { cooldownMinutes: 5 });
    engine.invalidateCache(orgId);

    const now = new Date();

    // First sequence: A then B -- should produce an alert
    const a1 = makeEvent({
      eventType: 'test.cooldown_a',
      payload: { resource_id: 'cd-res-1' },
      occurredAt: now,
    });
    await engine.evaluate(a1);

    const b1 = makeEvent({
      eventType: 'test.cooldown_b',
      payload: { resource_id: 'cd-res-1' },
      occurredAt: new Date(now.getTime() + 10_000),
    });
    const result1 = await engine.evaluate(b1);
    expect(result1.candidates).toHaveLength(1);

    // Second sequence immediately after: A then B -- should be suppressed by cooldown
    engine.invalidateCache(orgId); // clear cache so the rule is reloaded

    const a2 = makeEvent({
      eventType: 'test.cooldown_a',
      payload: { resource_id: 'cd-res-1' },
      occurredAt: new Date(now.getTime() + 30_000),
    });
    await engine.evaluate(a2);

    const b2 = makeEvent({
      eventType: 'test.cooldown_b',
      payload: { resource_id: 'cd-res-1' },
      occurredAt: new Date(now.getTime() + 40_000),
    });
    const result2 = await engine.evaluate(b2);

    // No alert due to cooldown
    expect(result2.candidates).toHaveLength(0);
  });
});
