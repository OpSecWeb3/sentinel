/**
 * Chunk 090 — Evaluator: windowed_sum (cumulative value threshold, groupByField)
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
import { windowedSumEvaluator } from '../../modules/chain/src/evaluators/windowed-sum.js';

const TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CONTRACT = '0xaabbccddee1234567890aabbccddee1234567890';

function makeTransferEvent(
  orgId: string,
  value: string,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'chain',
    eventType: 'chain.log',
    externalId: null,
    payload: {
      topics: [TOPIC0],
      address: CONTRACT,
      eventName: 'Transfer',
      blockNumber: '200',
      transactionHash: '0xdef',
      decodedArgs: { from: '0xsender', to: '0xrecipient', value },
    },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('Chunk 090 — windowed_sum evaluator', () => {
  let db: any;
  let redis: any;
  const evaluators = new Map([['chain:chain.windowed_sum', windowedSumEvaluator]]);

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert when sum exceeds threshold', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'chain' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TOPIC0,
        contractAddress: CONTRACT,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '1000',
        operator: 'gt',
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    // Send events whose sum exceeds 1000
    await engine.evaluate(makeTransferEvent(org.id, '600'));
    const result = await engine.evaluate(makeTransferEvent(org.id, '500'));

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0]!.title).toContain('windowed sum');
  });

  it('should not alert when sum is below threshold', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'chain' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TOPIC0,
        contractAddress: CONTRACT,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '1000',
        operator: 'gt',
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeTransferEvent(org.id, '100'));
    expect(result.candidates).toHaveLength(0);
  });

  it('should isolate groups when groupByField is set', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'chain' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TOPIC0,
        contractAddress: CONTRACT,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '500',
        operator: 'gt',
        groupByField: 'to',
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    // Send 300 to recipient A and 300 to recipient B — neither exceeds 500
    const makeEvtTo = (to: string, val: string) =>
      makeTransferEvent(org.id, val, {
        payload: {
          topics: [TOPIC0],
          address: CONTRACT,
          eventName: 'Transfer',
          blockNumber: '300',
          transactionHash: '0x' + Math.random().toString(16).slice(2, 10),
          decodedArgs: { from: '0xsender', to, value: val },
        },
      });

    await engine.evaluate(makeEvtTo('0xrecipientA', '300'));
    const resultA = await engine.evaluate(makeEvtTo('0xrecipientA', '100'));
    const resultB = await engine.evaluate(makeEvtTo('0xrecipientB', '300'));

    // Recipient A sum = 400, below 500
    expect(resultA.candidates).toHaveLength(0);
    // Recipient B sum = 300, below 500
    expect(resultB.candidates).toHaveLength(0);

    // Now push recipient A over threshold
    const resultA2 = await engine.evaluate(makeEvtTo('0xrecipientA', '300'));
    expect(resultA2.candidates.length).toBeGreaterThanOrEqual(1);
  });
});
