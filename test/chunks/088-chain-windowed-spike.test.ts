/**
 * Chunk 088 — Evaluator: windowed_spike (observation vs baseline, minBaselineCount)
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
import { windowedSpikeEvaluator } from '../../modules/chain/src/evaluators/windowed-spike.js';

const TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function makeChainLogEvent(orgId: string, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'chain',
    eventType: 'chain.log',
    externalId: null,
    payload: {
      topics: [TOPIC0],
      address: '0x1234567890abcdef1234567890abcdef12345678',
      eventName: 'Transfer',
      blockNumber: '100',
      transactionHash: '0xabc',
    },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('Chunk 088 — windowed_spike evaluator', () => {
  let db: any;
  let redis: any;
  const evaluators = new Map([['chain:chain.windowed_spike', windowedSpikeEvaluator]]);

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should not alert when baseline count is below minBaselineCount', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'chain' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 200,
        minBaselineCount: 10, // require 10 baseline events
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    // Send a single event — baseline will have 0 events, far below minBaselineCount
    const result = await engine.evaluate(makeChainLogEvent(org.id));
    expect(result.candidates).toHaveLength(0);
  });

  it('should not alert when event rate is within normal range', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'chain' });
    const rule = await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 200,
        minBaselineCount: 3,
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    // Seed baseline events in the baseline-only window (older than 5 min but within 60 min)
    const now = Date.now();
    const key = `sentinel:wspike:${rule.id}`;
    for (let i = 0; i < 6; i++) {
      await redis.zadd(key, now - 10 * 60_000 + i * 1000, `baseline-${i}`);
    }

    // Send one observation event — rate is comparable to baseline, no spike
    const result = await engine.evaluate(makeChainLogEvent(org.id));
    expect(result.candidates).toHaveLength(0);
  });

  it('should alert when observation count greatly exceeds baseline average', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'chain' });
    const rule = await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 100, // alert at 100% increase
        minBaselineCount: 3,
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    // Seed sparse baseline: 3 events spread across the baseline-only window
    const now = Date.now();
    const key = `sentinel:wspike:${rule.id}`;
    for (let i = 0; i < 3; i++) {
      await redis.zadd(key, now - 30 * 60_000 + i * 1000, `baseline-${i}`);
    }
    // Seed many recent events in the observation window to create a spike
    for (let i = 0; i < 20; i++) {
      await redis.zadd(key, now - 1000 + i, `obs-${i}`);
    }

    // The next event should see the spike
    const result = await engine.evaluate(makeChainLogEvent(org.id));
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0]!.title).toContain('rate spike');
  });
});
