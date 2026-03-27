import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvalContext, NormalizedEvent, RuleRow } from '@sentinel/shared/rules';
import { eventMatchEvaluator } from '../evaluators/event-match.js';
import { functionCallMatchEvaluator } from '../evaluators/function-call-match.js';
import { windowedCountEvaluator } from '../evaluators/windowed-count.js';
import { windowedSpikeEvaluator } from '../evaluators/windowed-spike.js';
import { balanceTrackEvaluator } from '../evaluators/balance-track.js';
import { statePollEvaluator } from '../evaluators/state-poll.js';
import { viewCallEvaluator } from '../evaluators/view-call.js';

// ---------------------------------------------------------------------------
// Constants — realistic blockchain values
// ---------------------------------------------------------------------------

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** keccak256("Approval(address,address,uint256)") */
const APPROVAL_TOPIC0 = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
/** transfer(address,uint256) 4-byte selector */
const TRANSFER_SELECTOR = '0xa9059cbb';
/** approve(address,uint256) 4-byte selector */
const APPROVE_SELECTOR = '0x095ea7b3';

const CONTRACT_ADDR = '0x6b175474e89094c44da98b954eedeac495271d0f'; // DAI
const OTHER_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // USDC
const ALICE_ADDR = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const BOB_ADDR = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';

const TX_HASH = '0xabc123def456789012345678901234567890abcdef1234567890abcdef123456';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'evt-1',
    orgId: 'org-1',
    moduleId: 'chain',
    eventType: 'chain.log',
    externalId: null,
    payload: {},
    occurredAt: new Date('2026-03-26T12:00:00Z'),
    receivedAt: new Date('2026-03-26T12:00:01Z'),
    ...overrides,
  };
}

function makeRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 'rule-1',
    detectionId: 'det-1',
    orgId: 'org-1',
    moduleId: 'chain',
    ruleType: 'chain.event_match',
    config: {},
    status: 'active',
    priority: 1,
    action: 'alert',
    ...overrides,
  };
}

function makeMockRedis(overrides: Record<string, any> = {}) {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    zadd: vi.fn().mockResolvedValue(1),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(0),
    zcount: vi.fn().mockResolvedValue(0),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    pexpire: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    lrange: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

function makeCtx(event: NormalizedEvent, rule: RuleRow, redis?: any): EvalContext {
  return { event, rule, redis: redis ?? ({} as any) };
}

// ===========================================================================
// event-match evaluator
// ===========================================================================

describe('eventMatchEvaluator', () => {
  it('triggers alert when topic0 matches', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { from: ALICE_ADDR, to: BOB_ADDR, value: '1000000000000000000' },
        eventName: 'Transfer',
        blockNumber: '19000000',
        transactionHash: TX_HASH,
        logIndex: 0,
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: { topic0: TRANSFER_TOPIC0 },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('Transfer');
    expect(result!.title).toContain(CONTRACT_ADDR);
    expect(result!.triggerData.type).toBe('event-match');
    expect(result!.triggerData.decodedArgs).toEqual({
      from: ALICE_ADDR,
      to: BOB_ADDR,
      value: '1000000000000000000',
    });
  });

  it('returns null when topic0 does not match', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [APPROVAL_TOPIC0],
        address: CONTRACT_ADDR,
        eventName: 'Approval',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: { topic0: TRANSFER_TOPIC0 },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('matches contract address filter (case-insensitive)', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR.toUpperCase(),
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: { topic0: TRANSFER_TOPIC0, contractAddress: CONTRACT_ADDR },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('returns null when contract address does not match', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: OTHER_CONTRACT,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: { topic0: TRANSFER_TOPIC0, contractAddress: CONTRACT_ADDR },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  // --- Field condition operators ---

  it('condition operator > triggers when actual exceeds value', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { value: '2000000000000000000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'value', operator: '>', value: '1000000000000000000' }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('condition operator < triggers when actual is below value', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { value: '500' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'value', operator: '<', value: '1000' }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('condition operator >= triggers when actual equals value', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { value: '1000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'value', operator: '>=', value: '1000' }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('condition operator <= triggers when actual equals value', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { value: '1000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'value', operator: '<=', value: '1000' }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('condition operator == triggers on string match (case-insensitive)', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { to: BOB_ADDR },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'to', operator: '==', value: BOB_ADDR.toUpperCase() }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('condition operator != triggers when values differ', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { to: BOB_ADDR },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'to', operator: '!=', value: ALICE_ADDR }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('multiple conditions (AND logic) - all pass', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { to: BOB_ADDR, value: '5000000000000000000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [
          { field: 'to', operator: '==', value: BOB_ADDR },
          { field: 'value', operator: '>', value: '1000000000000000000' },
        ],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('multiple conditions (AND logic) - one fails returns null', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { to: BOB_ADDR, value: '500' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [
          { field: 'to', operator: '==', value: BOB_ADDR },
          { field: 'value', operator: '>', value: '1000000000000000000' },
        ],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('missing field in conditions returns null', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
        decodedArgs: { to: BOB_ADDR },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'nonExistentField', operator: '>', value: '100' }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for wrong event type', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: CONTRACT_ADDR,
      },
    });
    const rule = makeRule({
      ruleType: 'chain.event_match',
      config: { topic0: TRANSFER_TOPIC0 },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// function-call-match evaluator
// ===========================================================================

describe('functionCallMatchEvaluator', () => {
  const baseTxPayload = {
    hash: TX_HASH,
    from: ALICE_ADDR,
    to: CONTRACT_ADDR,
    input: TRANSFER_SELECTOR + '0000000000000000000000000000000000000000000000000000000000000001',
    value: '0',
    blockNumber: '19000000',
    decodedArgs: { recipient: BOB_ADDR, amount: '1000000000000000000' },
    functionName: 'transfer',
  };

  it('triggers when function selector matches', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: baseTxPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: CONTRACT_ADDR,
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('transfer');
    expect(result!.triggerData.type).toBe('function-call-match');
    expect(result!.triggerData.from).toBe(ALICE_ADDR);
  });

  it('returns null when selector does not match', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: baseTxPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'approve(address,uint256)',
        selector: APPROVE_SELECTOR,
        contractAddress: CONTRACT_ADDR,
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null when tx.to does not match contract address', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: { ...baseTxPayload, to: OTHER_CONTRACT },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: CONTRACT_ADDR,
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('evaluates decoded argument conditions', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: baseTxPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: CONTRACT_ADDR,
        conditions: [{ field: 'amount', operator: '>=', value: '1000000000000000000' }],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('returns null when decoded argument condition fails', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: baseTxPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: CONTRACT_ADDR,
        conditions: [{ field: 'amount', operator: '>', value: '99000000000000000000' }],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for wrong event type (chain.log)', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: baseTxPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: CONTRACT_ADDR,
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null when tx.to is null (contract creation)', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: { ...baseTxPayload, to: null },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: CONTRACT_ADDR,
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// windowed-count evaluator
// ===========================================================================

describe('windowedCountEvaluator', () => {
  const baseLogPayload = {
    topics: [TRANSFER_TOPIC0],
    address: CONTRACT_ADDR,
    eventName: 'Transfer',
    blockNumber: '19000000',
    transactionHash: TX_HASH,
  };

  it('returns null when count is below threshold', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(2) });
    const event = makeEvent({ eventType: 'chain.log', payload: baseLogPayload });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: { topic0: TRANSFER_TOPIC0, windowMinutes: 60, threshold: 5 },
    });
    const result = await windowedCountEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
    expect(redis.zadd).toHaveBeenCalled();
    expect(redis.zremrangebyscore).toHaveBeenCalled();
  });

  it('triggers alert when count reaches threshold', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(5) });
    const event = makeEvent({ eventType: 'chain.log', payload: baseLogPayload });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: { topic0: TRANSFER_TOPIC0, windowMinutes: 60, threshold: 5 },
    });
    const result = await windowedCountEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('windowed');
    expect(result!.triggerData.type).toBe('windowed-count');
    expect(result!.triggerData.threshold).toBe(5);
    expect(result!.title).toContain('Transfer');
    expect(result!.title).toContain('60m');
  });

  it('groupBy field creates separate counters and triggers per group', async () => {
    const redis = makeMockRedis({
      zcard: vi.fn().mockResolvedValue(3),
      pexpire: vi.fn().mockResolvedValue(1),
    });
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        ...baseLogPayload,
        decodedArgs: { to: BOB_ADDR, value: '1000' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 10,
        threshold: 3,
        groupByField: 'to',
      },
    });
    const result = await windowedCountEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.triggerData.groupByField).toBe('to');
    expect(result!.triggerData.groupValue).toBe(BOB_ADDR.toLowerCase());
    expect(result!.triggerData.count).toBe(3);
    // Verify Redis key includes rule id and group value
    expect(redis.zadd).toHaveBeenCalled();
    expect(redis.pexpire).toHaveBeenCalled();
  });

  it('window expiry prunes old events via zremrangebyscore', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(1) });
    const event = makeEvent({ eventType: 'chain.log', payload: baseLogPayload });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: { topic0: TRANSFER_TOPIC0, windowMinutes: 30, threshold: 5 },
    });
    await windowedCountEvaluator.evaluate(makeCtx(event, rule, redis));

    // zremrangebyscore should be called with '-inf' and a cutoff timestamp
    expect(redis.zremrangebyscore).toHaveBeenCalledWith(
      expect.stringContaining('sentinel:window:rule-1'),
      '-inf',
      expect.any(Number),
    );
  });

  it('returns null for non chain.log event type', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({ eventType: 'chain.transaction', payload: baseLogPayload });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: { topic0: TRANSFER_TOPIC0, windowMinutes: 60, threshold: 5 },
    });
    const result = await windowedCountEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// windowed-spike evaluator
// ===========================================================================

describe('windowedSpikeEvaluator', () => {
  const baseLogPayload = {
    topics: [TRANSFER_TOPIC0],
    address: CONTRACT_ADDR,
    eventName: 'Transfer',
    blockNumber: '19000000',
    transactionHash: TX_HASH,
  };

  it('triggers when spike exceeds increasePercent threshold', async () => {
    // Observation window: 5 min, Baseline window: 60 min
    // baseline has 12 obs windows, baseline_count = 12, baseline_avg = 12/12 = 1
    // current_count = 5, spike% = ((5-1)/1)*100 = 400%
    const redis = makeMockRedis({
      zadd: vi.fn().mockResolvedValue(1),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zcount: vi.fn()
        .mockResolvedValueOnce(5)  // observation window count
        .mockResolvedValueOnce(12), // baseline window count
    });

    const event = makeEvent({ eventType: 'chain.log', payload: baseLogPayload });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 200,
        minBaselineCount: 3,
      },
    });
    const result = await windowedSpikeEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.triggerType).toBe('windowed');
    expect(result!.triggerData.type).toBe('windowed-spike');
    expect(result!.triggerData.spikePercent).toBeGreaterThanOrEqual(200);
  });

  it('returns null when rate is normal (no spike)', async () => {
    // baseline_count=12, baseline_avg=1, current=1, spike = 0%
    const redis = makeMockRedis({
      zcount: vi.fn()
        .mockResolvedValueOnce(1)  // observation
        .mockResolvedValueOnce(12), // baseline
    });

    const event = makeEvent({ eventType: 'chain.log', payload: baseLogPayload });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 200,
        minBaselineCount: 3,
      },
    });
    const result = await windowedSpikeEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('returns null when baseline count is below minBaselineCount', async () => {
    const redis = makeMockRedis({
      zcount: vi.fn()
        .mockResolvedValueOnce(10) // observation (high)
        .mockResolvedValueOnce(1),  // baseline (too few)
    });

    const event = makeEvent({ eventType: 'chain.log', payload: baseLogPayload });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 200,
        minBaselineCount: 3,
      },
    });
    const result = await windowedSpikeEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('groupBy variant triggers with correct group metadata', async () => {
    const redis = makeMockRedis({
      zcount: vi.fn()
        .mockResolvedValueOnce(8)   // observation
        .mockResolvedValueOnce(12),  // baseline
      pexpire: vi.fn().mockResolvedValue(1),
    });

    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        ...baseLogPayload,
        decodedArgs: { to: BOB_ADDR },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 200,
        minBaselineCount: 3,
        groupByField: 'to',
      },
    });
    const result = await windowedSpikeEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.triggerData.groupByField).toBe('to');
    expect(result!.triggerData.groupValue).toBe(BOB_ADDR.toLowerCase());
    expect(redis.pexpire).toHaveBeenCalled();
  });

  it('returns null for wrong event type', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({ eventType: 'chain.transaction', payload: baseLogPayload });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 200,
        minBaselineCount: 3,
      },
    });
    const result = await windowedSpikeEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// balance-track evaluator
// ===========================================================================

describe('balanceTrackEvaluator', () => {
  const baseBalancePayload = {
    address: ALICE_ADDR,
    balance: '5000000000000000000', // 5 ETH
    blockNumber: '19000000',
  };

  it('percent_change triggers when change exceeds threshold', async () => {
    // Previous: 10 ETH, Current: 5 ETH => 50% drop
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('10000000000000000000'),
    });

    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: baseBalancePayload,
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: { conditionType: 'percent_change', value: '10' }, // 10% threshold
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.triggerData.type).toBe('balance-track');
    expect(result!.triggerData.conditionType).toBe('percent_change');
    expect(result!.triggerData.direction).toBe('drop');
  });

  it('percent_change returns null when change is within threshold', async () => {
    // Previous: 5.1 ETH, Current: 5 ETH => ~1.96% change
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('5100000000000000000'),
    });

    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: baseBalancePayload,
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: { conditionType: 'percent_change', value: '10' }, // 10% threshold
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('threshold_above triggers when value exceeds threshold', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: ALICE_ADDR,
        balance: '100000000000000000000', // 100 ETH
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: { conditionType: 'threshold_above', value: '50000000000000000000' }, // 50 ETH
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('threshold_above');
    expect(result!.title).toContain('threshold_above');
  });

  it('threshold_above returns null when value is below threshold', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: ALICE_ADDR,
        balance: '10000000000000000000', // 10 ETH
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: { conditionType: 'threshold_above', value: '50000000000000000000' }, // 50 ETH
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('threshold_below triggers when value drops below threshold', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: ALICE_ADDR,
        balance: '100000000000000000', // 0.1 ETH
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: { conditionType: 'threshold_below', value: '1000000000000000000' }, // 1 ETH
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('threshold_below');
  });

  it('threshold_below returns null when value is above threshold', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: baseBalancePayload,
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: { conditionType: 'threshold_below', value: '1000000000000000000' }, // 1 ETH
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('bidirectional mode triggers on rise in windowed percent_change', async () => {
    // Windowed snapshots: had a low of 1 ETH, now current is 5 ETH => 400% rise
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('1000000000000000000'),
      zrangebyscore: vi.fn().mockResolvedValue([
        '1000000000000000000',   // 1 ETH (trough)
        '2000000000000000000',   // 2 ETH
        '3000000000000000000',   // 3 ETH
      ]),
    });

    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: baseBalancePayload, // 5 ETH
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'percent_change',
        value: '50',
        windowMs: 3600000, // 1 hour
        bidirectional: true,
      },
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.triggerData.direction).toBe('rise');
  });

  it('returns null for wrong event type', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({ eventType: 'chain.log', payload: baseBalancePayload });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: { conditionType: 'threshold_above', value: '100' },
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('includes token label for ERC-20 token balance', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: ALICE_ADDR,
        tokenAddress: CONTRACT_ADDR,
        balance: '100000000000000000000', // 100 tokens
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: { conditionType: 'threshold_above', value: '50000000000000000000' },
    });
    const result = await balanceTrackEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.title).toContain(`token ${CONTRACT_ADDR}`);
  });
});

// ===========================================================================
// state-poll evaluator
// ===========================================================================

describe('statePollEvaluator', () => {
  const baseStatePayload = {
    address: CONTRACT_ADDR,
    slot: '0x0000000000000000000000000000000000000000000000000000000000000001',
    value: '500',
    blockNumber: '19000000',
  };

  it('changed condition triggers on any difference', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('400'), // previous value
    });

    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: baseStatePayload,
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'changed' },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('deferred');
    expect(result!.triggerData.type).toBe('state-poll');
    expect(result!.triggerData.conditionType).toBe('changed');
    expect(result!.triggerData.direction).toBe('change');
    expect(result!.triggerData.previousValue).toBe('400');
    expect(result!.triggerData.currentValue).toBe('500');
  });

  it('changed condition returns null when value is the same', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('500'), // same as current
    });

    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: baseStatePayload,
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'changed' },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('changed condition returns null when no previous value exists', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });

    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: baseStatePayload,
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'changed' },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('threshold_above triggers when value exceeds threshold', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: { ...baseStatePayload, value: '1000' },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'threshold_above', value: '500' },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('threshold_above');
    expect(result!.triggerData.threshold).toBe('500');
  });

  it('threshold_above returns null when value is equal to threshold', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: baseStatePayload, // value = 500
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'threshold_above', value: '500' },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('threshold_below triggers when value is below threshold', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: { ...baseStatePayload, value: '50' },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'threshold_below', value: '100' },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('threshold_below');
  });

  it('windowed_percent_change triggers on large deviation from rolling mean', async () => {
    // Recent values: [100, 100, 100, 100, 100] => mean = 100
    // Current value: 200 => 100% deviation from mean
    const redis = makeMockRedis({
      lrange: vi.fn().mockResolvedValue(['200', '100', '100', '100', '100', '100']),
    });

    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: { ...baseStatePayload, value: '200' },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'windowed_percent_change',
        percentThreshold: 50,
        windowSize: 100,
      },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('windowed_percent_change');
    expect(result!.triggerData.direction).toBe('rise');
  });

  it('windowed_percent_change returns null when deviation is small', async () => {
    // Recent values all close to 100
    const redis = makeMockRedis({
      lrange: vi.fn().mockResolvedValue(['101', '100', '99', '100', '101']),
    });

    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: { ...baseStatePayload, value: '101' },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'windowed_percent_change',
        percentThreshold: 50,
        windowSize: 100,
      },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('windowed_percent_change returns null with fewer than 2 recent values', async () => {
    const redis = makeMockRedis({
      lrange: vi.fn().mockResolvedValue(['500']),
    });

    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: baseStatePayload,
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'windowed_percent_change',
        percentThreshold: 10,
        windowSize: 100,
      },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('returns null for wrong event type', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({ eventType: 'chain.log', payload: baseStatePayload });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'changed' },
    });
    const result = await statePollEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// view-call evaluator
// ===========================================================================

describe('viewCallEvaluator', () => {
  const baseViewPayload = {
    contractAddress: CONTRACT_ADDR,
    functionName: 'totalSupply',
    returnValues: { '0': '1000000000000000000000000' },
    blockNumber: '19000000',
  };

  it('triggers when single condition matches return value', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: baseViewPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: CONTRACT_ADDR,
        functionSignature: 'totalSupply()',
        resultField: 'result',
        conditions: [{ field: 'result', operator: '>', value: '500000000000000000000000' }],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('deferred');
    expect(result!.triggerData.type).toBe('view-call');
    expect(result!.title).toContain('totalSupply');
    expect(result!.triggerData.contractAddress).toBe(CONTRACT_ADDR);
  });

  it('returns null when condition does not match', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: baseViewPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: CONTRACT_ADDR,
        functionSignature: 'totalSupply()',
        resultField: 'result',
        conditions: [{ field: 'result', operator: '<', value: '100' }],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('multiple conditions AND logic - all pass triggers alert', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: CONTRACT_ADDR,
        functionName: 'getReserves',
        returnValues: {
          reserve0: '5000000000000000000000',
          reserve1: '10000000000',
          blockTimestamp: '1711000000',
        },
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: CONTRACT_ADDR,
        functionSignature: 'getReserves()',
        conditions: [
          { field: 'reserve0', operator: '>', value: '1000000000000000000000' },
          { field: 'reserve1', operator: '>', value: '1000000000' },
        ],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('multiple conditions AND logic - one fails returns null', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: CONTRACT_ADDR,
        functionName: 'getReserves',
        returnValues: {
          reserve0: '5000000000000000000000',
          reserve1: '500', // too low
        },
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: CONTRACT_ADDR,
        functionSignature: 'getReserves()',
        conditions: [
          { field: 'reserve0', operator: '>', value: '1000000000000000000000' },
          { field: 'reserve1', operator: '>', value: '1000000000' },
        ],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('resultField mapping exposes unnamed return value (key "0") under custom field name', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: CONTRACT_ADDR,
        functionName: 'balanceOf',
        returnValues: { '0': '999000000000000000000' },
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: CONTRACT_ADDR,
        functionSignature: 'balanceOf(address)',
        resultField: 'balance',
        conditions: [{ field: 'balance', operator: '>=', value: '999000000000000000000' }],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('returns null when contract address does not match', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: { ...baseViewPayload, contractAddress: OTHER_CONTRACT },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: CONTRACT_ADDR,
        functionSignature: 'totalSupply()',
        conditions: [{ field: 'result', operator: '>', value: '0' }],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for wrong event type', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: baseViewPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: CONTRACT_ADDR,
        functionSignature: 'totalSupply()',
        conditions: [],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('triggers with empty conditions (no filtering)', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: baseViewPayload,
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: CONTRACT_ADDR,
        functionSignature: 'totalSupply()',
        conditions: [],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });
});
