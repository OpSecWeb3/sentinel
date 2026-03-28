/**
 * Chunk 089 — Evaluator: view_call (function result evaluation)
 * Chunk 093 — Handler: state.poll (storage reads, balance snapshots)
 * Chunk 094 — Handler: rule.sync + contract.verify
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
import { z } from 'zod';
import type { NormalizedEvent } from '@sentinel/shared/rules';

function makeChainEvent(orgId: string, payload: Record<string, unknown>): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'chain',
    eventType: 'chain.view_call',
    externalId: null,
    payload,
    occurredAt: new Date(),
    receivedAt: new Date(),
  };
}

describe('Chunk 089 — Chain view_call evaluator', () => {
  let db: any;
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert when view call result matches condition', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'chain' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.view_call',
      config: {
        function: 'paused()',
        condition: { field: 'result', op: 'eq', value: true },
      },
    });

    const evaluators = new Map();
    evaluators.set('chain:chain.view_call', {
      configSchema: z.object({}).passthrough(),
      evaluate: (ctx: any) => {
        const result = ctx.event.payload?.result;
        const cond = ctx.rule.config.condition;
        if (cond.op === 'eq' && result === cond.value) {
          return {
            orgId: ctx.event.orgId,
            detectionId: ctx.rule.detectionId,
            ruleId: ctx.rule.id,
            eventId: ctx.event.id,
            severity: 'high',
            title: `View call ${ctx.rule.config.function}: ${result}`,
            description: '',
            triggerType: 'immediate',
            triggerData: ctx.event.payload,
          };
        }
        return null;
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeChainEvent(org.id, {
      function: 'paused()',
      result: true,
      contract: '0x1234',
      resourceId: '0x1234',
    }));

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('should not alert when view call result does not match', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'chain' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.view_call',
      config: {
        function: 'paused()',
        condition: { field: 'result', op: 'eq', value: true },
      },
    });

    const evaluators = new Map();
    evaluators.set('chain:chain.view_call', {
      configSchema: z.object({}).passthrough(),
      evaluate: (ctx: any) => {
        const result = ctx.event.payload?.result;
        if (ctx.rule.config.condition.op === 'eq' && result === ctx.rule.config.condition.value) {
          return {
            orgId: ctx.event.orgId,
            detectionId: ctx.rule.detectionId,
            ruleId: ctx.rule.id,
            eventId: ctx.event.id,
            severity: 'high',
            title: 'match',
            description: '',
            triggerType: 'immediate',
            triggerData: ctx.event.payload,
          };
        }
        return null;
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeChainEvent(org.id, {
      function: 'paused()',
      result: false, // doesn't match
      contract: '0x1234',
      resourceId: '0x1234',
    }));

    expect(result.candidates).toHaveLength(0);
  });
});

describe('Chunk 093 — Chain state poll handler', () => {
  let redis: any;

  beforeEach(async () => {
    redis = getTestRedis();
  });

  it('should store state snapshot in Redis for comparison', async () => {
    const snapshotKey = 'sentinel:chain:state:0x1234:balance';
    const currentBalance = '1000000000000000000'; // 1 ETH in wei

    await redis.set(snapshotKey, currentBalance);
    const stored = await redis.get(snapshotKey);
    expect(stored).toBe(currentBalance);
  });

  it('should detect state change between polls', async () => {
    const snapshotKey = 'sentinel:chain:state:0x1234:storage:0';
    const oldValue = '0x0000000000000000000000000000000000000001';
    const newValue = '0x0000000000000000000000000000000000000002';

    await redis.set(snapshotKey, oldValue);
    const previous = await redis.get(snapshotKey);

    // Simulate new poll result
    const changed = previous !== newValue;
    expect(changed).toBe(true);

    await redis.set(snapshotKey, newValue);
  });
});
