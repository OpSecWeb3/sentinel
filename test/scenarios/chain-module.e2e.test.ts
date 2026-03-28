/**
 * Chain Module E2E Tests
 *
 * Integration tests for the Chain module evaluators. Each scenario creates
 * detections and rules in the database, builds NormalizedEvents with chain
 * event payloads, and runs them through the RuleEngine against a real
 * Postgres DB and Redis instance.
 *
 * Evaluators under test:
 *   - chain.event_match       (eventMatchEvaluator)
 *   - chain.balance_track     (balanceTrackEvaluator)
 *   - chain.windowed_count    (windowedCountEvaluator)
 *   - chain.windowed_sum      (windowedSumEvaluator)
 *   - chain.windowed_spike    (windowedSpikeEvaluator)
 *   - chain.state_poll        (statePollEvaluator)
 *   - chain.function_call_match (functionCallMatchEvaluator)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTestDb,
  getTestRedis,
  getTestSql,
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestRule,
  createTestEvent,
} from '../../test/helpers/setup.js';

import { RuleEngine } from '@sentinel/shared/rule-engine';
import type { NormalizedEvent, RuleEvaluator } from '@sentinel/shared/rules';

import { eventMatchEvaluator } from '../../modules/chain/src/evaluators/event-match.js';
import { balanceTrackEvaluator } from '../../modules/chain/src/evaluators/balance-track.js';
import { windowedCountEvaluator } from '../../modules/chain/src/evaluators/windowed-count.js';
import { windowedSumEvaluator } from '../../modules/chain/src/evaluators/windowed-sum.js';
import { windowedSpikeEvaluator } from '../../modules/chain/src/evaluators/windowed-spike.js';
import { statePollEvaluator } from '../../modules/chain/src/evaluators/state-poll.js';
import { functionCallMatchEvaluator } from '../../modules/chain/src/evaluators/function-call-match.js';

// ---------------------------------------------------------------------------
// Constants — deterministic addresses and hashes for test payloads
// ---------------------------------------------------------------------------

const CONTRACT_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const NETWORK_ID = '1'; // Ethereum mainnet
const TX_HASH = '0xaabbccddee11223344556677889900aabbccddee11223344556677889900aabb';
const ADDR_ALICE = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADDR_BOB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const ADDR_CAROL = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const ADDR_DAVE = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const ADDR_NEW_IMPL = '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the evaluator registry from a list of evaluators. */
function buildRegistry(...evaluators: RuleEvaluator[]): Map<string, RuleEvaluator> {
  const map = new Map<string, RuleEvaluator>();
  for (const ev of evaluators) {
    map.set(`${ev.moduleId}:${ev.ruleType}`, ev);
  }
  return map;
}

/** Create a NormalizedEvent from a DB event row + payload. */
function toNormalizedEvent(
  row: { id: string; orgId: string; moduleId: string; eventType: string },
  payload: Record<string, unknown>,
): NormalizedEvent {
  return {
    id: row.id,
    orgId: row.orgId,
    moduleId: row.moduleId,
    eventType: row.eventType,
    externalId: null,
    payload,
    occurredAt: new Date(),
    receivedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Shared state — initialized in beforeEach
// ---------------------------------------------------------------------------

let db: ReturnType<typeof getTestDb>;
let redis: ReturnType<typeof getTestRedis>;
let sql: ReturnType<typeof getTestSql>;
let user: Awaited<ReturnType<typeof createTestUser>>;
let org: Awaited<ReturnType<typeof createTestOrg>>;

beforeEach(async () => {
  await cleanTables();
  resetCounters();
  db = getTestDb();
  redis = getTestRedis();
  sql = getTestSql();

  user = await createTestUser({ username: 'chain-tester' });
  org = await createTestOrg({ name: 'Chain Org', slug: 'chain-org' });
  await addMembership(org.id, user.id, 'admin');
});

// ==========================================================================
// 1. Large Transfer — Threshold Boundary (BigInt comparison)
// ==========================================================================

describe('Large Transfer — Threshold Boundary', () => {
  const ONE_ETH = '1000000000000000000'; // 1e18

  async function setupLargeTransferDetection() {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'chain',
      name: 'Large Transfer Monitor',
      severity: 'high',
    });

    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.event_match',
      config: {
        eventSignature: 'Transfer(address,address,uint256)',
        eventName: 'Transfer',
        conditions: [{ field: 'value', operator: '>', value: ONE_ETH }],
      },
      action: 'alert',
    });

    return { engine, detection };
  }

  function transferPayload(value: string): Record<string, unknown> {
    return {
      contractAddress: CONTRACT_ADDR,
      networkId: NETWORK_ID,
      eventName: 'Transfer',
      transactionHash: TX_HASH,
      blockNumber: '19000000',
      logIndex: 0,
      eventArgs: { from: ADDR_ALICE, to: ADDR_BOB, value },
    };
  }

  it('should NOT alert when transfer value is just below threshold', async () => {
    const { engine } = await setupLargeTransferDetection();
    const justBelow = '999999999999999999'; // 1 ETH - 1 wei

    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.event.matched',
      payload: transferPayload(justBelow),
    });

    const normalized = toNormalizedEvent(evt, transferPayload(justBelow));
    const result = await engine.evaluate(normalized);

    expect(result.candidates).toHaveLength(0);
  });

  it('should alert when transfer value is just above threshold', async () => {
    const { engine, detection } = await setupLargeTransferDetection();
    const justAbove = '1000000000000000001'; // 1 ETH + 1 wei

    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.event.matched',
      payload: transferPayload(justAbove),
    });

    const normalized = toNormalizedEvent(evt, transferPayload(justAbove));
    const result = await engine.evaluate(normalized);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.detectionId).toBe(detection.id);
    expect(result.candidates[0]!.triggerData).toMatchObject({
      contractAddress: CONTRACT_ADDR,
    });
  });

  it('should NOT alert when transfer value exactly equals threshold', async () => {
    const { engine } = await setupLargeTransferDetection();

    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.event.matched',
      payload: transferPayload(ONE_ETH),
    });

    const normalized = toNormalizedEvent(evt, transferPayload(ONE_ETH));
    const result = await engine.evaluate(normalized);

    // Operator is strictly >, so exact equality should NOT fire
    expect(result.candidates).toHaveLength(0);
  });
});

// ==========================================================================
// 2. Ownership Transfer Detection
// ==========================================================================

describe('Ownership Transfer Detection', () => {
  it('should fire alert when OwnershipTransferred event is received', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'chain',
      name: 'Ownership Monitor',
      severity: 'critical',
    });

    // Mirror the chain-ownership-monitor template rule config
    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.event_match',
      config: {
        eventSignature: 'OwnershipTransferred(address,address)',
        eventName: 'OwnershipTransferred',
      },
      action: 'alert',
    });

    const payload: Record<string, unknown> = {
      contractAddress: CONTRACT_ADDR,
      networkId: NETWORK_ID,
      eventName: 'OwnershipTransferred',
      transactionHash: TX_HASH,
      blockNumber: '19000100',
      logIndex: 0,
      eventArgs: { previousOwner: ADDR_ALICE, newOwner: ADDR_BOB },
    };

    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.event.matched',
      payload,
    });

    const normalized = toNormalizedEvent(evt, payload);
    const result = await engine.evaluate(normalized);

    expect(result.candidates).toHaveLength(1);

    const alert = result.candidates[0]!;
    expect(alert.detectionId).toBe(detection.id);
    expect(alert.severity).toBe('critical');
    // Verify previousOwner and newOwner are present in trigger data (nested under decodedArgs)
    expect(alert.triggerData).toMatchObject({
      decodedArgs: { previousOwner: ADDR_ALICE, newOwner: ADDR_BOB },
    });
  });
});

// ==========================================================================
// 3. Storage Slot Change Detection
// ==========================================================================

describe('Storage Slot Change Detection', () => {
  async function setupStorageDetection() {
    const evaluators = buildRegistry(statePollEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'chain',
      name: 'Storage Anomaly Detector',
      severity: 'high',
    });

    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'changed',
      },
      action: 'alert',
    });

    return { engine, detection };
  }

  it('should alert when storage slot value has changed', async () => {
    const { engine, detection } = await setupStorageDetection();

    // First snapshot to prime the previous value in Redis
    const payload1: Record<string, unknown> = {
      address: CONTRACT_ADDR,
      slot: '0x0',
      value: '0x1',
      blockNumber: '19000000',
    };
    const evt1 = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.state_snapshot',
      payload: payload1,
    });
    const normalized1 = toNormalizedEvent(evt1, payload1);
    await engine.evaluate(normalized1);

    // Second snapshot with a different value — should trigger
    const payload2: Record<string, unknown> = {
      address: CONTRACT_ADDR,
      slot: '0x0',
      value: '0x2',
      blockNumber: '19000001',
    };
    const evt2 = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.state_snapshot',
      payload: payload2,
    });
    const normalized2 = toNormalizedEvent(evt2, payload2);
    const result = await engine.evaluate(normalized2);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.detectionId).toBe(detection.id);
  });

  it('should NOT alert when storage slot value is unchanged', async () => {
    const { engine } = await setupStorageDetection();

    // First snapshot to prime the previous value in Redis
    const payload1: Record<string, unknown> = {
      address: CONTRACT_ADDR,
      slot: '0x0',
      value: '0x1',
      blockNumber: '19000000',
    };
    const evt1 = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.state_snapshot',
      payload: payload1,
    });
    const normalized1 = toNormalizedEvent(evt1, payload1);
    await engine.evaluate(normalized1);

    // Second snapshot with same value — should NOT trigger
    const payload2: Record<string, unknown> = {
      address: CONTRACT_ADDR,
      slot: '0x0',
      value: '0x1',
      blockNumber: '19000001',
    };
    const evt2 = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.state_snapshot',
      payload: payload2,
    });
    const normalized2 = toNormalizedEvent(evt2, payload2);
    const result = await engine.evaluate(normalized2);

    expect(result.candidates).toHaveLength(0);
  });
});

// ==========================================================================
// 4. Windowed Count — Per-Entity Grouping
// ==========================================================================

describe('Windowed Count — Per-Entity Grouping', () => {
  // keccak256('Transfer(address,address,uint256)')
  const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  async function setupWindowedCountDetection() {
    const evaluators = buildRegistry(windowedCountEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'chain',
      name: 'Repeated Transfer Detector',
      severity: 'high',
    });

    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        groupByField: 'to',
        windowMinutes: 60,
        threshold: 3,
      },
      action: 'alert',
    });

    return { engine, detection };
  }

  function transferLogPayload(
    toAddr: string,
    blockNumber: number,
  ): Record<string, unknown> {
    return {
      topics: [TRANSFER_TOPIC0],
      address: CONTRACT_ADDR,
      eventName: 'Transfer',
      transactionHash: TX_HASH,
      blockNumber: String(blockNumber),
      decodedArgs: { from: ADDR_ALICE, to: toAddr, value: '500000000000000000' },
    };
  }

  it('should alert when same recipient receives threshold transfers within window', async () => {
    const { engine, detection } = await setupWindowedCountDetection();

    // Send 3 transfer events to the same address (BOB) — threshold is 3
    for (let i = 0; i < 3; i++) {
      const payload = transferLogPayload(ADDR_BOB, 19000200 + i);
      const evt = await createTestEvent(org.id, {
        moduleId: 'chain',
        eventType: 'chain.log',
        payload,
      });

      const normalized = toNormalizedEvent(evt, payload);
      const result = await engine.evaluate(normalized);

      if (i < 2) {
        // First two should NOT trigger (count < threshold)
        expect(result.candidates).toHaveLength(0);
      } else {
        // Third event should trigger the alert
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]!.detectionId).toBe(detection.id);
      }
    }
  });

  it('should NOT alert when different recipients each receive fewer than threshold', async () => {
    const { engine } = await setupWindowedCountDetection();

    // Send 2 events to BOB, 1 to CAROL — none hit threshold of 3
    const recipients = [ADDR_BOB, ADDR_BOB, ADDR_CAROL];

    for (const [i, addr] of recipients.entries()) {
      const payload = transferLogPayload(addr, 19000300 + i);
      const evt = await createTestEvent(org.id, {
        moduleId: 'chain',
        eventType: 'chain.log',
        payload,
      });

      const normalized = toNormalizedEvent(evt, payload);
      const result = await engine.evaluate(normalized);

      expect(result.candidates).toHaveLength(0);
    }
  });
});

// ==========================================================================
// 5. Balance Drop Percentage
// ==========================================================================

describe('Balance Drop Percentage', () => {
  async function setupBalanceDropDetection() {
    const evaluators = buildRegistry(balanceTrackEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'chain',
      name: 'Fund Drainage Detection',
      severity: 'critical',
    });

    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'percent_change',
        value: '20',
      },
      action: 'alert',
    });

    return { engine, detection };
  }

  it('should alert when balance drops by more than configured percentage', async () => {
    const { engine, detection } = await setupBalanceDropDetection();

    // First snapshot to prime the previous value in Redis (10 ETH)
    const payload1: Record<string, unknown> = {
      address: CONTRACT_ADDR,
      balance: '10000000000000000000',
      blockNumber: '19000000',
    };
    const evt1 = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.balance_snapshot',
      payload: payload1,
    });
    const normalized1 = toNormalizedEvent(evt1, payload1);
    await engine.evaluate(normalized1);

    // Second snapshot: 25% drop (7.5 ETH) — exceeds 20% threshold
    const payload2: Record<string, unknown> = {
      address: CONTRACT_ADDR,
      balance: '7500000000000000000',
      blockNumber: '19000001',
    };
    const evt2 = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.balance_snapshot',
      payload: payload2,
    });
    const normalized2 = toNormalizedEvent(evt2, payload2);
    const result = await engine.evaluate(normalized2);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.detectionId).toBe(detection.id);
  });

  it('should NOT alert when balance drops by less than configured percentage', async () => {
    const { engine } = await setupBalanceDropDetection();

    // First snapshot to prime the previous value in Redis (10 ETH)
    const payload1: Record<string, unknown> = {
      address: CONTRACT_ADDR,
      balance: '10000000000000000000',
      blockNumber: '19000000',
    };
    const evt1 = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.balance_snapshot',
      payload: payload1,
    });
    const normalized1 = toNormalizedEvent(evt1, payload1);
    await engine.evaluate(normalized1);

    // Second snapshot: 15% drop (8.5 ETH) — below 20% threshold
    const payload2: Record<string, unknown> = {
      address: CONTRACT_ADDR,
      balance: '8500000000000000000',
      blockNumber: '19000001',
    };
    const evt2 = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.balance_snapshot',
      payload: payload2,
    });
    const normalized2 = toNormalizedEvent(evt2, payload2);
    const result = await engine.evaluate(normalized2);

    expect(result.candidates).toHaveLength(0);
  });
});

// ==========================================================================
// 6. Proxy Upgrade Event Detection
// ==========================================================================

describe('Proxy Upgrade Event Detection', () => {
  it('should alert when Upgraded(address) event is emitted', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'chain',
      name: 'Proxy Upgrade Monitor',
      severity: 'critical',
    });

    // Use the proxy-upgrade template config: Upgraded(address)
    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.event_match',
      config: {
        eventSignature: 'Upgraded(address)',
        eventName: 'Upgraded',
      },
      action: 'alert',
    });

    const payload: Record<string, unknown> = {
      contractAddress: CONTRACT_ADDR,
      networkId: NETWORK_ID,
      eventName: 'Upgraded',
      transactionHash: TX_HASH,
      blockNumber: '19000400',
      logIndex: 0,
      eventArgs: { implementation: ADDR_NEW_IMPL },
    };

    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.event.matched',
      payload,
    });

    const normalized = toNormalizedEvent(evt, payload);
    const result = await engine.evaluate(normalized);

    expect(result.candidates).toHaveLength(1);

    const alert = result.candidates[0]!;
    expect(alert.detectionId).toBe(detection.id);
    expect(alert.severity).toBe('critical');
    // The new implementation address should be present in the trigger data
    expect(alert.triggerData).toMatchObject({
      decodedArgs: { implementation: ADDR_NEW_IMPL },
    });
  });

  it('should NOT alert when a different event signature is received', async () => {
    const evaluators = buildRegistry(eventMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'chain',
      name: 'Proxy Upgrade Monitor (no match)',
      severity: 'critical',
    });

    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.event_match',
      config: {
        eventSignature: 'Upgraded(address)',
        eventName: 'Upgraded',
      },
      action: 'alert',
    });

    const payload: Record<string, unknown> = {
      contractAddress: CONTRACT_ADDR,
      networkId: NETWORK_ID,
      eventName: 'Transfer',
      transactionHash: TX_HASH,
      blockNumber: '19000401',
      logIndex: 0,
      eventArgs: { from: ADDR_ALICE, to: ADDR_BOB, value: '1000' },
    };

    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.event.matched',
      payload,
    });

    const normalized = toNormalizedEvent(evt, payload);
    const result = await engine.evaluate(normalized);

    expect(result.candidates).toHaveLength(0);
  });
});

// ==========================================================================
// 7. Function Call Match with Filter
// ==========================================================================

describe('Function Call Match with Filter', () => {
  // 4-byte selector for transfer(address,uint256) = 0xa9059cbb
  const TRANSFER_SELECTOR = '0xa9059cbb';

  async function setupFunctionCallDetection() {
    const evaluators = buildRegistry(functionCallMatchEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'chain',
      name: 'Custom Function Call Monitor',
      severity: 'high',
    });

    await createTestRule(detection.id, org.id, {
      moduleId: 'chain',
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        functionName: 'transfer',
        contractAddress: CONTRACT_ADDR,
        selector: TRANSFER_SELECTOR,
        conditions: [
          { field: 'amount', operator: '>', value: '1000' },
        ],
      },
      action: 'alert',
    });

    return { engine, detection };
  }

  function functionCallPayload(amount: number): Record<string, unknown> {
    return {
      hash: TX_HASH,
      from: ADDR_ALICE,
      to: CONTRACT_ADDR,
      input: TRANSFER_SELECTOR + '0'.repeat(56),
      value: '0',
      blockNumber: '19000500',
      functionName: 'transfer',
      decodedArgs: { to: ADDR_BOB, amount },
    };
  }

  it('should NOT alert when function call amount is below filter value', async () => {
    const { engine } = await setupFunctionCallDetection();

    const payload = functionCallPayload(500); // below 1000 threshold
    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.transaction',
      payload,
    });

    const normalized = toNormalizedEvent(evt, payload);
    const result = await engine.evaluate(normalized);

    expect(result.candidates).toHaveLength(0);
  });

  it('should alert when function call amount exceeds filter value', async () => {
    const { engine, detection } = await setupFunctionCallDetection();

    const payload = functionCallPayload(2000); // above 1000 threshold
    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.transaction',
      payload,
    });

    const normalized = toNormalizedEvent(evt, payload);
    const result = await engine.evaluate(normalized);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.detectionId).toBe(detection.id);
  });

  it('should NOT alert when function call amount exactly equals filter value', async () => {
    const { engine } = await setupFunctionCallDetection();

    const payload = functionCallPayload(1000); // operator is >, so exact match should not fire
    const evt = await createTestEvent(org.id, {
      moduleId: 'chain',
      eventType: 'chain.transaction',
      payload,
    });

    const normalized = toNormalizedEvent(evt, payload);
    const result = await engine.evaluate(normalized);

    expect(result.candidates).toHaveLength(0);
  });
});
