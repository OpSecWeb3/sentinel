import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvalContext, NormalizedEvent, RuleRow } from '@sentinel/shared/rules';
import { eventMatchEvaluator } from '../evaluators/event-match.js';
import { functionCallMatchEvaluator } from '../evaluators/function-call-match.js';
import { windowedCountEvaluator } from '../evaluators/windowed-count.js';
import { windowedSpikeEvaluator } from '../evaluators/windowed-spike.js';
import { balanceTrackEvaluator } from '../evaluators/balance-track.js';
import { statePollEvaluator } from '../evaluators/state-poll.js';
import { viewCallEvaluator } from '../evaluators/view-call.js';
import { windowedSumEvaluator } from '../evaluators/windowed-sum.js';

// ---------------------------------------------------------------------------
// Constants - realistic Ethereum addresses, selectors, and topic hashes
// ---------------------------------------------------------------------------

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** keccak256("Approval(address,address,uint256)") */
const APPROVAL_TOPIC0 = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
/** keccak256("OwnershipTransferred(address,address)") */
const OWNERSHIP_TRANSFERRED_TOPIC0 = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
/** keccak256("Paused(address)") */
const PAUSED_TOPIC0 = '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258';
/** keccak256("Unpaused(address)") */
const UNPAUSED_TOPIC0 = '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa';
/** keccak256("Upgraded(address)") */
const UPGRADED_TOPIC0 = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';
/** keccak256("ApprovalForAll(address,address,bool)") */
const APPROVAL_FOR_ALL_TOPIC0 = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';

/** transfer(address,uint256) */
const TRANSFER_SELECTOR = '0xa9059cbb';
/** approve(address,uint256) */
const APPROVE_SELECTOR = '0x095ea7b3';
/** multicall(bytes[]) */
const MULTICALL_SELECTOR = '0xac9650d8';
/** upgradeTo(address) */
const UPGRADE_TO_SELECTOR = '0x3659cfe6';
/** renounceOwnership() */
const RENOUNCE_OWNERSHIP_SELECTOR = '0x715018a6';
/** setApprovalForAll(address,bool) */
const SET_APPROVAL_FOR_ALL_SELECTOR = '0xa22cb465';
/** transferOwnership(address) */
const TRANSFER_OWNERSHIP_SELECTOR = '0xf2fde38b';

const DAI_ADDR = '0x6b175474e89094c44da98b954eedeac495271d0f';
const USDC_ADDR = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ALICE = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const BOB = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';
const CHARLIE = '0x1234567890abcdef1234567890abcdef12345678';
const BLACKLISTED = '0x00000000000000000000000000000000deadbeef';
const TREASURY = '0xbeef00000000000000000000000000000000cafe';
const PROXY_ADDR = '0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b';

const TX_HASH = '0xabc123def456789012345678901234567890abcdef1234567890abcdef123456';
const TX_HASH_2 = '0xdef456789012345678901234567890abcdef1234567890abcdef123456abc123';

const ONE_ETH = '1000000000000000000';
const ONE_MILLION_ETH = '1000000000000000000000000';
const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let eventCounter = 0;

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  eventCounter += 1;
  return {
    id: `evt-${eventCounter}`,
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
    zrange: vi.fn().mockResolvedValue([]),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    pexpire: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    lrange: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

function makeCtx(
  event: NormalizedEvent,
  rule: RuleRow,
  extra?: Partial<EvalContext>,
): EvalContext {
  return {
    event,
    rule,
    redis: makeMockRedis(),
    ...extra,
  };
}

beforeEach(() => {
  eventCounter = 0;
});

// ===========================================================================
// 1. EVENT MATCH EVALUATOR (20 tests)
// ===========================================================================

describe('eventMatchEvaluator', () => {
  // --- 1. ERC-20 Transfer event matching by topic0 ---
  it('matches an ERC-20 Transfer event by topic0', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0, ALICE, BOB],
        address: DAI_ADDR,
        data: '0x0000000000000000000000000000000000000000000000056bc75e2d63100000',
        blockNumber: '19000000',
        transactionHash: TX_HASH,
        logIndex: 0,
        decodedArgs: { from: ALICE, to: BOB, value: '100000000000000000000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: { topic0: TRANSFER_TOPIC0, conditions: [] },
    });
    const ctx = makeCtx(event, rule);
    const result = await eventMatchEvaluator.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Transfer');
    expect(result!.triggerType).toBe('immediate');
  });

  // --- 2. Transfer with amount > 1M condition ---
  it('fires when Transfer amount exceeds 1M tokens', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        blockNumber: '19000001',
        transactionHash: TX_HASH,
        logIndex: 1,
        decodedArgs: { from: ALICE, to: BOB, value: '2000000000000000000000000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'value', operator: '>', value: ONE_MILLION_ETH }],
      },
    });
    const ctx = makeCtx(event, rule);
    const result = await eventMatchEvaluator.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.triggerData.decodedArgs).toHaveProperty('value');
  });

  // --- 3. Transfer to blacklisted address ---
  it('detects a Transfer to a blacklisted address', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: USDC_ADDR,
        decodedArgs: { from: ALICE, to: BLACKLISTED, value: '500000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'to', operator: '==', value: BLACKLISTED }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 4. Contract address filter - wrong address no match ---
  it('returns null when contract address does not match', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: USDC_ADDR,
        decodedArgs: { from: ALICE, to: BOB, value: '1000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 5. Multiple conditions AND logic ---
  it('requires ALL conditions to match (AND logic)', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { from: ALICE, to: BOB, value: '500000000000000000000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [
          { field: 'to', operator: '==', value: BOB },
          { field: 'value', operator: '>', value: ONE_MILLION_ETH },
        ],
      },
    });
    // value is 500 ETH, which is less than 1M ETH, so second condition fails
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 6. Decoded args condition on nested field ---
  it('matches decoded args field equality condition', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { from: ALICE, to: TREASURY, value: '10000000000000000000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'from', operator: '==', value: ALICE }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 7. BigInt comparison for token amounts ---
  it('correctly compares large BigInt token amounts', async () => {
    const largeAmount = '99999999999999999999999999999'; // very large
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { from: ALICE, to: BOB, value: largeAmount },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'value', operator: '>=', value: '99999999999999999999999999999' }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 8. Zero-value transfer detection ---
  it('detects a zero-value transfer', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { from: ALICE, to: BOB, value: '0' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'value', operator: '==', value: '0' }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 9. Event from different contract - no match ---
  it('returns null when event is from an unmonitored contract', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: WETH_ADDR,
        decodedArgs: { from: ALICE, to: BOB, value: '1000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 10. Non-chain event type - returns null ---
  it('returns null for non-chain.log event types', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: {},
      },
    });
    const rule = makeRule({
      config: { topic0: TRANSFER_TOPIC0, conditions: [] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 11. Approval event matching ---
  it('matches an Approval event', async () => {
    const event = makeEvent({
      payload: {
        topics: [APPROVAL_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { owner: ALICE, spender: BOB, value: MAX_UINT256 },
        eventName: 'Approval',
      },
    });
    const rule = makeRule({
      config: { topic0: APPROVAL_TOPIC0, conditions: [] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Approval');
  });

  // --- 12. OwnershipTransferred detection ---
  it('detects OwnershipTransferred event', async () => {
    const event = makeEvent({
      payload: {
        topics: [OWNERSHIP_TRANSFERRED_TOPIC0],
        address: PROXY_ADDR,
        decodedArgs: { previousOwner: ALICE, newOwner: BOB },
        eventName: 'OwnershipTransferred',
      },
    });
    const rule = makeRule({
      config: { topic0: OWNERSHIP_TRANSFERRED_TOPIC0, conditions: [] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('OwnershipTransferred');
  });

  // --- 13. Topic0 must match exactly (case insensitive) ---
  it('matches topic0 case-insensitively', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0.toUpperCase()],
        address: DAI_ADDR,
        decodedArgs: {},
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: { topic0: TRANSFER_TOPIC0.toLowerCase(), conditions: [] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 14. Missing topics array - graceful null ---
  it('returns null when payload has no topics', async () => {
    const event = makeEvent({
      payload: { address: DAI_ADDR },
    });
    const rule = makeRule({
      config: { topic0: TRANSFER_TOPIC0, conditions: [] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 15. Condition with != operator ---
  it('supports != operator to exclude specific addresses', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { from: ALICE, to: BOB, value: '1000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'to', operator: '!=', value: CHARLIE }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 16. Event with empty conditions always matches ---
  it('matches when conditions array is empty', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { from: ALICE, to: BOB, value: '1000' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: { topic0: TRANSFER_TOPIC0, conditions: [] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 17. Multiple events from same transaction (logIndex difference) ---
  it('matches each event from the same transaction independently', async () => {
    const evt1 = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        logIndex: 0,
        transactionHash: TX_HASH,
        decodedArgs: { from: ALICE, to: BOB, value: '100' },
        eventName: 'Transfer',
      },
    });
    const evt2 = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        logIndex: 1,
        transactionHash: TX_HASH,
        decodedArgs: { from: ALICE, to: CHARLIE, value: '200' },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: { topic0: TRANSFER_TOPIC0, conditions: [] },
    });
    const r1 = await eventMatchEvaluator.evaluate(makeCtx(evt1, rule));
    const r2 = await eventMatchEvaluator.evaluate(makeCtx(evt2, rule));
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.eventId).not.toBe(r2!.eventId);
  });

  // --- 18. Proxy contract upgraded event ---
  it('detects proxy Upgraded event', async () => {
    const event = makeEvent({
      payload: {
        topics: [UPGRADED_TOPIC0],
        address: PROXY_ADDR,
        decodedArgs: { implementation: CHARLIE },
        eventName: 'Upgraded',
      },
    });
    const rule = makeRule({
      config: {
        topic0: UPGRADED_TOPIC0,
        contractAddress: PROXY_ADDR,
        conditions: [],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Upgraded');
  });

  // --- 19. Pause/Unpause detection ---
  it('detects Paused event on a contract', async () => {
    const event = makeEvent({
      payload: {
        topics: [PAUSED_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { account: ALICE },
        eventName: 'Paused',
      },
    });
    const rule = makeRule({
      config: { topic0: PAUSED_TOPIC0, contractAddress: DAI_ADDR, conditions: [] },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Paused');
  });

  // --- 20. Condition on missing field returns null gracefully ---
  it('returns null when condition references a field not in decodedArgs', async () => {
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        decodedArgs: { from: ALICE, to: BOB },
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      config: {
        topic0: TRANSFER_TOPIC0,
        conditions: [{ field: 'nonExistentField', operator: '>', value: '0' }],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 21. Custom event with complex args ---
  it('matches a custom event with complex decoded args and conditions', async () => {
    const customTopic0 = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const event = makeEvent({
      payload: {
        topics: [customTopic0],
        address: DAI_ADDR,
        decodedArgs: {
          user: ALICE,
          amount: '5000000000000000000',
          action: 'stake',
        },
        eventName: 'Staked',
      },
    });
    const rule = makeRule({
      config: {
        topic0: customTopic0,
        conditions: [
          { field: 'amount', operator: '>=', value: ONE_ETH },
          { field: 'user', operator: '==', value: ALICE },
        ],
      },
    });
    const result = await eventMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.triggerData.eventName).toBe('Staked');
  });
});

// ===========================================================================
// 2. FUNCTION CALL MATCH EVALUATOR (12 tests)
// ===========================================================================

describe('functionCallMatchEvaluator', () => {
  // --- 1. transfer() function call detection ---
  it('detects a transfer() call to the monitored contract', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: `${TRANSFER_SELECTOR}0000000000000000000000000000000000000000000000000000000000000001`,
        value: '0',
        blockNumber: '19000000',
        decodedArgs: { to: BOB, amount: '1000000000000000000' },
        functionName: 'transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('transfer');
  });

  // --- 2. approve() with unlimited allowance ---
  it('detects approve() with max uint256 allowance', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: `${APPROVE_SELECTOR}0000000000000000000000000000000000000000000000000000000000000001`,
        value: '0',
        decodedArgs: { spender: BOB, amount: MAX_UINT256 },
        functionName: 'approve',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'approve(address,uint256)',
        selector: APPROVE_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [{ field: 'amount', operator: '==', value: MAX_UINT256 }],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 3. Function selector matching ---
  it('matches by 4-byte function selector', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: `${TRANSFER_SELECTOR}deadbeef`,
        value: '0',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 4. Wrong contract address - no match ---
  it('returns null when transaction is to a different contract', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: USDC_ADDR,
        input: `${TRANSFER_SELECTOR}deadbeef`,
        value: '0',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 5. Decoded function args with conditions ---
  it('checks decoded arg conditions on function call', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: `${TRANSFER_SELECTOR}deadbeef`,
        value: '0',
        decodedArgs: { to: BOB, amount: '500' },
        functionName: 'transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [{ field: 'amount', operator: '>', value: '1000' }],
      },
    });
    // amount is 500 which is not > 1000
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 6. Multicall detection ---
  it('detects a multicall() transaction', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: `${MULTICALL_SELECTOR}00000000`,
        value: '0',
        functionName: 'multicall',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'multicall(bytes[])',
        selector: MULTICALL_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('multicall');
  });

  // --- 7. upgradeProxy function call ---
  it('detects upgradeTo() on a proxy contract', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: PROXY_ADDR,
        input: `${UPGRADE_TO_SELECTOR}${CHARLIE.slice(2).padStart(64, '0')}`,
        value: '0',
        decodedArgs: { newImplementation: CHARLIE },
        functionName: 'upgradeTo',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'upgradeTo(address)',
        selector: UPGRADE_TO_SELECTOR,
        contractAddress: PROXY_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.triggerData.functionName).toBe('upgradeTo');
  });

  // --- 8. renounceOwnership detection ---
  it('detects renounceOwnership() call', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: RENOUNCE_OWNERSHIP_SELECTOR,
        value: '0',
        functionName: 'renounceOwnership',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'renounceOwnership()',
        selector: RENOUNCE_OWNERSHIP_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 9. Non-transaction event - returns null ---
  it('returns null for non-transaction events', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: `${TRANSFER_SELECTOR}deadbeef`,
        value: '0',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 10. Function with no conditions matches any call ---
  it('matches any call with correct selector when conditions are empty', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: CHARLIE,
        to: DAI_ADDR,
        input: `${TRANSFER_SELECTOR}ffffffff`,
        value: '0',
        decodedArgs: { to: ALICE, amount: '1' },
        functionName: 'transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 11. setApprovalForAll detection ---
  it('detects setApprovalForAll call', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: `${SET_APPROVAL_FOR_ALL_SELECTOR}0000000000000000000000000000000000000000000000000000000000000001`,
        value: '0',
        decodedArgs: { operator: BOB, approved: true },
        functionName: 'setApprovalForAll',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'setApprovalForAll(address,bool)',
        selector: SET_APPROVAL_FOR_ALL_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.triggerData.functionName).toBe('setApprovalForAll');
  });

  // --- 12. Null `to` address (contract creation) returns null ---
  it('returns null for contract creation transactions (null to)', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: null,
        input: `${TRANSFER_SELECTOR}deadbeef`,
        value: '0',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 13. Input too short (no selector) returns null ---
  it('returns null when input data is too short to contain a selector', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: '0x1234', // only 2 bytes, less than 4-byte selector
        value: '0',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transfer(address,uint256)',
        selector: TRANSFER_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 14. transferOwnership to suspicious address ---
  it('detects transferOwnership to a suspicious address via condition', async () => {
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        hash: TX_HASH,
        from: ALICE,
        to: DAI_ADDR,
        input: `${TRANSFER_OWNERSHIP_SELECTOR}${BLACKLISTED.slice(2).padStart(64, '0')}`,
        value: '0',
        decodedArgs: { newOwner: BLACKLISTED },
        functionName: 'transferOwnership',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.function_call_match',
      config: {
        functionSignature: 'transferOwnership(address)',
        selector: TRANSFER_OWNERSHIP_SELECTOR,
        contractAddress: DAI_ADDR,
        conditions: [{ field: 'newOwner', operator: '==', value: BLACKLISTED }],
      },
    });
    const result = await functionCallMatchEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.triggerData.decodedArgs).toEqual({ newOwner: BLACKLISTED });
  });
});

// ===========================================================================
// 3. WINDOWED COUNT EVALUATOR (15 tests)
// ===========================================================================

describe('windowedCountEvaluator', () => {
  // --- 1. 50 transfers in 10 minutes exceeds threshold of 20 ---
  it('fires when event count reaches threshold within window', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(50) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 10,
        threshold: 20,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerType).toBe('windowed');
    expect(result!.triggerData.type).toBe('windowed-count');
  });

  // --- 2. Count at threshold - fires (>= comparison) ---
  it('fires when count equals threshold (>= comparison)', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(5) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 60,
        threshold: 5,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 3. Count below threshold - no alert ---
  it('returns null when count is below threshold', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(3) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 60,
        threshold: 5,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 4. Verifies pruning of old events (zremrangebyscore called) ---
  it('prunes stale entries outside the window', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(1) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 10,
        threshold: 100,
      },
    });
    await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(redis.zremrangebyscore).toHaveBeenCalled();
    expect(redis.zadd).toHaveBeenCalled();
  });

  // --- 5. GroupBy field - separate counts per address ---
  it('groups counts separately by decoded arg field', async () => {
    const redis = makeMockRedis({
      zadd: vi.fn().mockResolvedValue(1),
      zcard: vi.fn().mockResolvedValue(10),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '100' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 10,
        threshold: 5,
        groupByField: 'to',
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.groupByField).toBe('to');
    expect(result!.triggerData.groupValue).toBe(BOB.toLowerCase());
  });

  // --- 6. Reset after window passes (count returns to 0) ---
  it('returns null after window expiry resets count', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(0) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 1,
        threshold: 10,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 7. Rapid mint events (potential exploit) ---
  it('detects rapid Mint events exceeding threshold', async () => {
    const MINT_TOPIC0 = '0x0f6798a560793a54c3bcfe86a93cde1e73087d944c0ea20544137d4121396885';
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(100) });
    const event = makeEvent({
      payload: {
        topics: [MINT_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Mint',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: MINT_TOPIC0,
        windowMinutes: 1,
        threshold: 50,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Mint');
  });

  // --- 8. Flash loan detection (many events in 1 block) ---
  it('detects flash loan pattern with many events in single block', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(30) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        blockNumber: '19000000',
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 1,
        threshold: 20,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 9. Threshold=1 fires on first event (zcard returns 1 after add) ---
  it('fires on first event when threshold is 1', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(1) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 60,
        threshold: 1,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 10. Large window (24h) accumulation ---
  it('supports large 24-hour window accumulation', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(999) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 1440,
        threshold: 1000,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    // 999 < 1000 threshold
    expect(result).toBeNull();
  });

  // --- 11. Mixed events, only matching topic0 counted ---
  it('returns null when topic0 does not match the rule', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(100) });
    const event = makeEvent({
      payload: {
        topics: [APPROVAL_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Approval',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 10,
        threshold: 5,
      },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 12. GroupBy with high-cardinality field ---
  it('handles groupBy with unique from-address grouping', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(3) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '100' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: {
        topic0: TRANSFER_TOPIC0,
        windowMinutes: 10,
        threshold: 5,
        groupByField: 'from',
      },
    });
    // count=3 < threshold=5
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 13. Concurrent events from different rules (separate keys) ---
  it('uses distinct Redis keys per rule ID', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(10) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule1 = makeRule({
      id: 'rule-a',
      ruleType: 'chain.windowed_count',
      config: { topic0: TRANSFER_TOPIC0, windowMinutes: 5, threshold: 5 },
    });
    const rule2 = makeRule({
      id: 'rule-b',
      ruleType: 'chain.windowed_count',
      config: { topic0: TRANSFER_TOPIC0, windowMinutes: 5, threshold: 5 },
    });
    await windowedCountEvaluator.evaluate({ event, rule: rule1, redis });
    await windowedCountEvaluator.evaluate({ event, rule: rule2, redis });
    const zaddCalls = redis.zadd.mock.calls;
    // First call uses rule-a key, second uses rule-b key
    expect(zaddCalls[0][0]).toContain('rule-a');
    expect(zaddCalls[1][0]).toContain('rule-b');
  });

  // --- 14. TTL is set on the window key ---
  it('sets pexpire TTL on the window key', async () => {
    const redis = makeMockRedis({ zcard: vi.fn().mockResolvedValue(1) });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: { topic0: TRANSFER_TOPIC0, windowMinutes: 10, threshold: 100 },
    });
    await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(redis.pexpire).toHaveBeenCalledWith(
      expect.any(String),
      10 * 60_000,
    );
  });

  // --- 15. Non-chain.log event returns null ---
  it('returns null for chain.transaction events', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.transaction',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_count',
      config: { topic0: TRANSFER_TOPIC0, windowMinutes: 10, threshold: 5 },
    });
    const result = await windowedCountEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });
});

// ===========================================================================
// 4. WINDOWED SPIKE EVALUATOR (12 tests)
// ===========================================================================

describe('windowedSpikeEvaluator', () => {
  // --- 1. 300% spike from normal activity ---
  it('triggers on a 300% spike over baseline', async () => {
    const redis = makeMockRedis({
      // observation window: 15 events
      zcount: vi.fn()
        .mockResolvedValueOnce(15)   // current count (observation)
        .mockResolvedValueOnce(10),  // baseline count
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    // baselineAvg = 10 / (60/5) = 10/12 = 0.833
    // spikePercent = ((15 - 0.833) / 0.833) * 100 = 1700%
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
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.triggerData.type).toBe('windowed-spike');
  });

  // --- 2. Gradual increase - no spike ---
  it('returns null for gradual increase below spike threshold', async () => {
    const redis = makeMockRedis({
      // observation: 2 events, baseline: 20 events over 60min
      // baselineAvg = 20 / (60/5) = 1.667
      // spike% = ((2 - 1.667) / 1.667) * 100 = 20% < 200%
      zcount: vi.fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(20),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
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
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 3. Baseline too small (minBaselineCount not met) ---
  it('returns null when baseline count is below minBaselineCount', async () => {
    const redis = makeMockRedis({
      zcount: vi.fn()
        .mockResolvedValueOnce(100)  // observation: lots of events
        .mockResolvedValueOnce(2),   // baseline: only 2 events (below min of 3)
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 100,
        minBaselineCount: 3,
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 4. Spike after quiet period ---
  it('detects spike after a quiet baseline period', async () => {
    const redis = makeMockRedis({
      // observation: 10, baseline: 3 events in 60min
      // baselineAvg = 3 / (60/5) = 0.25
      // spike% = ((10 - 0.25) / 0.25) * 100 = 3900%
      zcount: vi.fn()
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(3),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
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
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 5. Token launch spike (1000%+) ---
  it('triggers on extreme token launch spike exceeding 1000%', async () => {
    const redis = makeMockRedis({
      // observation: 500, baseline: 5 events in 120min
      // baselineAvg = 5 / (120/5) = 0.208
      // spike% = ((500 - 0.208) / 0.208) * 100 = ~240284%
      zcount: vi.fn()
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(5),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: WETH_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 120,
        increasePercent: 1000,
        minBaselineCount: 5,
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  // --- 6. Grouped spike (per-address) ---
  it('detects spike grouped by recipient address', async () => {
    const redis = makeMockRedis({
      zcount: vi.fn()
        .mockResolvedValueOnce(20)   // observation count for BOB
        .mockResolvedValueOnce(5),   // baseline count for BOB
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '1000' },
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
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.groupByField).toBe('to');
  });

  // --- 7. Observation window smaller than baseline ---
  it('works with observation < baseline (standard config)', async () => {
    const redis = makeMockRedis({
      zcount: vi.fn()
        .mockResolvedValueOnce(5)   // observation: 5 events in 2min
        .mockResolvedValueOnce(10), // baseline: 10 events in 60min
      // baselineAvg = 10 / (60/2) = 10/30 = 0.333
      // spike% = ((5 - 0.333) / 0.333) * 100 = 1400%
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 2,
        baselineMinutes: 60,
        increasePercent: 300,
        minBaselineCount: 5,
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 8. Equal counts - 0% increase - no spike ---
  it('returns null when observation rate matches baseline average', async () => {
    const redis = makeMockRedis({
      // observation: 1, baseline: 12 events in 60min
      // baselineAvg = 12 / (60/5) = 1.0
      // spike% = ((1 - 1) / 1) * 100 = 0%
      zcount: vi.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(12),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
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
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 9. Negative "spike" (decrease) - no alert ---
  it('returns null when observation count is below baseline average', async () => {
    const redis = makeMockRedis({
      // observation: 0, baseline: 60 events in 60min
      // baselineAvg = 60 / (60/5) = 5.0
      // spike% = ((0 - 5) / 5) * 100 = -100%
      zcount: vi.fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(60),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
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
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 10. First events ever (no baseline) - no alert ---
  it('returns null when there is no baseline data (first events)', async () => {
    const redis = makeMockRedis({
      zcount: vi.fn()
        .mockResolvedValueOnce(5)  // observation: 5 events
        .mockResolvedValueOnce(0), // baseline: 0 events
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_spike',
      config: {
        topic0: TRANSFER_TOPIC0,
        observationMinutes: 5,
        baselineMinutes: 60,
        increasePercent: 100,
        minBaselineCount: 3,
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 11. Exact threshold boundary (200% = threshold of 200) ---
  it('triggers when spike equals exactly the increasePercent threshold', async () => {
    const redis = makeMockRedis({
      // observation: 3, baseline: 12 events in 60min
      // baselineAvg = 12 / (60/5) = 1.0
      // spike% = ((3 - 1) / 1) * 100 = 200%
      zcount: vi.fn()
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(12),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
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
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 12. Non-chain.log event returns null ---
  it('returns null for chain.balance_snapshot events', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
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
      },
    });
    const result = await windowedSpikeEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });
});

// ===========================================================================
// 5. BALANCE TRACK EVALUATOR (12 tests)
// ===========================================================================

describe('balanceTrackEvaluator', () => {
  // --- 1. 50% balance drop on DAO treasury ---
  it('alerts on a 50% balance drop from previous value', async () => {
    const redis = makeMockRedis({
      // Previous balance: 200 ETH
      get: vi.fn().mockResolvedValue('200000000000000000000'),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '100000000000000000000', // 100 ETH (50% drop)
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'percent_change',
        value: '25', // 25% threshold
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.direction).toBe('drop');
  });

  // --- 2. Balance rises above 1000 ETH ---
  it('alerts when balance exceeds threshold_above', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('500000000000000000000'),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '1500000000000000000000', // 1500 ETH
        blockNumber: '19000001',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'threshold_above',
        value: '1000000000000000000000', // 1000 ETH
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('threshold_above');
  });

  // --- 3. Balance drops below 100 ETH ---
  it('alerts when balance drops below threshold', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('200000000000000000000'),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '50000000000000000000', // 50 ETH
        blockNumber: '19000002',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'threshold_below',
        value: '100000000000000000000', // 100 ETH
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('threshold_below');
  });

  // --- 4. Percent change with bidirectional=true detects rise ---
  it('detects rise with bidirectional percent_change and windowed snapshots', async () => {
    const windowMs = 3600_000; // 1 hour
    const now = Date.now();
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('100000000000000000000'), // prev 100 ETH
      zadd: vi.fn().mockResolvedValue(1),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrangebyscore: vi.fn().mockResolvedValue([
        `${now - 1000}:100000000000000000000`, // 100 ETH
        `${now}:500000000000000000000`,         // 500 ETH (current)
      ]),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '500000000000000000000', // 500 ETH (400% rise from min)
        blockNumber: '19000003',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'percent_change',
        value: '50', // 50% threshold
        windowMs,
        bidirectional: true,
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.direction).toBe('rise');
  });

  // --- 5. Small fluctuation below threshold - no alert ---
  it('returns null for small fluctuation within threshold', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('1000000000000000000000'), // 1000 ETH
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '990000000000000000000', // 990 ETH (1% drop)
        blockNumber: '19000004',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'percent_change',
        value: '10', // 10% threshold
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 6. First snapshot (no previous) - no alert for percent_change ---
  it('returns null on first snapshot for percent_change (no previous value)', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue(null), // no previous value
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '1000000000000000000000',
        blockNumber: '19000005',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'percent_change',
        value: '10',
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 7. Windowed comparison (peak-to-current drop) ---
  it('detects drop from peak in windowed mode', async () => {
    const windowMs = 3600_000;
    const now = Date.now();
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('500000000000000000000'),
      zadd: vi.fn().mockResolvedValue(1),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrangebyscore: vi.fn().mockResolvedValue([
        `${now - 2000}:1000000000000000000000`, // peak: 1000 ETH
        `${now - 1000}:800000000000000000000`,  // 800 ETH
        `${now}:300000000000000000000`,          // current: 300 ETH (70% drop from peak)
      ]),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '300000000000000000000', // 300 ETH
        blockNumber: '19000006',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'percent_change',
        value: '50', // 50% threshold
        windowMs,
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.direction).toBe('drop');
  });

  // --- 8. Token balance (ERC-20) tracking ---
  it('tracks ERC-20 token balance with tokenAddress in payload', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        tokenAddress: DAI_ADDR,
        balance: '5000000000000000000000000', // 5M DAI
        blockNumber: '19000007',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'threshold_above',
        value: '1000000000000000000000000', // 1M DAI
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.title).toContain('token');
    expect(result!.title).toContain(DAI_ADDR);
  });

  // --- 9. Zero balance detection ---
  it('detects balance dropping to zero (below threshold 1)', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('1000000000000000000'),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '0',
        blockNumber: '19000008',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'threshold_below',
        value: '1', // below 1 wei
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 10. Very large balance (BigInt handling) ---
  it('handles very large uint256-scale balances correctly', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue(MAX_UINT256),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: MAX_UINT256,
        blockNumber: '19000009',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'threshold_above',
        value: '100000000000000000000000000000000000000', // large but less than max
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 11. Balance unchanged - no alert for percent_change ---
  it('returns null when balance is unchanged (0% change)', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('1000000000000000000000'),
    });
    const event = makeEvent({
      eventType: 'chain.balance_snapshot',
      payload: {
        address: TREASURY,
        balance: '1000000000000000000000', // same as previous
        blockNumber: '19000010',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'percent_change',
        value: '5', // 5% threshold
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 12. Non-balance_snapshot event returns null ---
  it('returns null for chain.log events', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        address: TREASURY,
        balance: '1000000000000000000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.balance_track',
      config: {
        conditionType: 'threshold_above',
        value: '100',
      },
    });
    const result = await balanceTrackEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });
});

// ===========================================================================
// 6. STATE POLL EVALUATOR (10 tests)
// ===========================================================================

describe('statePollEvaluator', () => {
  // --- 1. Owner address changed (value changed) ---
  it('detects owner address change in storage slot', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue(ALICE.replace('0x', '')),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x0',
        value: BOB.replace('0x', ''),
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'changed' },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('changed');
    expect(result!.triggerData.direction).toBe('change');
    expect(result!.triggerType).toBe('deferred');
  });

  // --- 2. Paused state toggled (changed condition with 0->1) ---
  it('detects paused flag toggle from 0 to 1', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('0'),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x5',
        value: '1',
        blockNumber: '19000001',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'changed' },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 3. Threshold above detection ---
  it('alerts when state value exceeds threshold_above', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('500'),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x10',
        value: '1500',
        blockNumber: '19000002',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'threshold_above',
        value: '1000',
      },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('threshold_above');
  });

  // --- 4. Threshold below detection ---
  it('alerts when state value drops below threshold_below', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('1000'),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x10',
        value: '50',
        blockNumber: '19000003',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'threshold_below',
        value: '100',
      },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('threshold_below');
  });

  // --- 5. Windowed percent change from rolling mean ---
  it('triggers windowed_percent_change when value deviates from rolling mean', async () => {
    // Recent values (lpush prepends, so index 0 is current): [500, 100, 100, 100, 100]
    // Previous values (slice(1)): [100, 100, 100, 100]
    // Mean = 100, current = 500, deviation = 400%
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('100'),
      lpush: vi.fn().mockResolvedValue(5),
      ltrim: vi.fn().mockResolvedValue('OK'),
      lrange: vi.fn().mockResolvedValue(['500', '100', '100', '100', '100']),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x20',
        value: '500',
        blockNumber: '19000004',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'windowed_percent_change',
        percentThreshold: 50,
        windowSize: 10,
      },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.conditionType).toBe('windowed_percent_change');
    expect(result!.triggerData.direction).toBe('rise');
  });

  // --- 6. State unchanged - no alert ---
  it('returns null when state value has not changed', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('42'),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x0',
        value: '42',
        blockNumber: '19000005',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'changed' },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 7. First poll (no history) - no alert for changed ---
  it('returns null on first poll for changed condition (no previous state)', async () => {
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue(null),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x0',
        value: '1',
        blockNumber: '19000006',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: { conditionType: 'changed' },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 8. Rolling window mean calculation with drop ---
  it('detects windowed_percent_change drop from rolling mean', async () => {
    // Recent: [10, 100, 100, 100, 100]
    // Previous mean = 100, current = 10, deviation = 90%
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('100'),
      lpush: vi.fn().mockResolvedValue(5),
      ltrim: vi.fn().mockResolvedValue('OK'),
      lrange: vi.fn().mockResolvedValue(['10', '100', '100', '100', '100']),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x30',
        value: '10',
        blockNumber: '19000007',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'windowed_percent_change',
        percentThreshold: 50,
        windowSize: 10,
      },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.direction).toBe('drop');
  });

  // --- 9. Large deviation triggers alert ---
  it('triggers alert on large deviation from rolling mean', async () => {
    // Recent: [10000, 100, 100, 100] -> mean=100, dev=9900%
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('100'),
      lpush: vi.fn().mockResolvedValue(4),
      ltrim: vi.fn().mockResolvedValue('OK'),
      lrange: vi.fn().mockResolvedValue(['10000', '100', '100', '100']),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x40',
        value: '10000',
        blockNumber: '19000008',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'windowed_percent_change',
        percentThreshold: 100,
        windowSize: 5,
      },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 10. Small deviation within threshold - no alert ---
  it('returns null when deviation is within percent threshold', async () => {
    // Recent: [105, 100, 100, 100] -> mean=100, dev=5%
    const redis = makeMockRedis({
      get: vi.fn().mockResolvedValue('100'),
      lpush: vi.fn().mockResolvedValue(4),
      ltrim: vi.fn().mockResolvedValue('OK'),
      lrange: vi.fn().mockResolvedValue(['105', '100', '100', '100']),
    });
    const event = makeEvent({
      eventType: 'chain.state_snapshot',
      payload: {
        address: DAI_ADDR,
        slot: '0x40',
        value: '105',
        blockNumber: '19000009',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.state_poll',
      config: {
        conditionType: 'windowed_percent_change',
        percentThreshold: 50,
        windowSize: 5,
      },
    });
    const result = await statePollEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });
});

// ===========================================================================
// 7. VIEW CALL EVALUATOR (8 tests)
// ===========================================================================

describe('viewCallEvaluator', () => {
  // --- 1. totalSupply changed unexpectedly ---
  it('triggers when totalSupply exceeds condition threshold', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: DAI_ADDR,
        functionName: 'totalSupply',
        returnValues: { '0': '5000000000000000000000000000' },
        blockNumber: '19000000',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: DAI_ADDR,
        functionSignature: 'totalSupply()',
        functionName: 'totalSupply',
        conditions: [{ field: 'result', operator: '>', value: '1000000000000000000000000000' }],
        resultField: 'result',
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('totalSupply');
    expect(result!.triggerType).toBe('deferred');
  });

  // --- 2. balanceOf below threshold ---
  it('triggers when balanceOf return is below threshold', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: DAI_ADDR,
        functionName: 'balanceOf',
        returnValues: { '0': '50000000000000000000' }, // 50 tokens
        blockNumber: '19000001',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: DAI_ADDR,
        functionSignature: 'balanceOf(address)',
        functionName: 'balanceOf',
        conditions: [{ field: 'result', operator: '<', value: '100000000000000000000' }],
        resultField: 'result',
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 3. Complex return value with conditions ---
  it('evaluates conditions on named return values', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: DAI_ADDR,
        functionName: 'getReserves',
        returnValues: {
          reserve0: '5000000000000000000000',
          reserve1: '10000000000',
          blockTimestampLast: '1711459200',
        },
        blockNumber: '19000002',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: DAI_ADDR,
        functionSignature: 'getReserves()',
        conditions: [
          { field: 'reserve0', operator: '>', value: '1000000000000000000000' },
          { field: 'reserve1', operator: '<', value: '50000000000' },
        ],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 4. Wrong contract address - no match ---
  it('returns null when contract address does not match', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: USDC_ADDR,
        functionName: 'totalSupply',
        returnValues: { '0': '5000000000000' },
        blockNumber: '19000003',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: DAI_ADDR,
        functionSignature: 'totalSupply()',
        conditions: [],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 5. Result field mapping (unnamed return mapped to resultField) ---
  it('maps unnamed return value to configured resultField', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: DAI_ADDR,
        functionName: 'decimals',
        returnValues: { '0': '18' },
        blockNumber: '19000004',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: DAI_ADDR,
        functionSignature: 'decimals()',
        conditions: [{ field: 'result', operator: '==', value: '18' }],
        resultField: 'result',
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 6. Non-view-call event - returns null ---
  it('returns null for chain.log events', async () => {
    const event = makeEvent({
      eventType: 'chain.log',
      payload: {
        contractAddress: DAI_ADDR,
        functionName: 'totalSupply',
        returnValues: { '0': '1000' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: DAI_ADDR,
        functionSignature: 'totalSupply()',
        conditions: [],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });

  // --- 7. Boolean return value condition ---
  it('evaluates boolean-like return values with == operator', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: DAI_ADDR,
        functionName: 'paused',
        returnValues: { '0': 'true' },
        blockNumber: '19000005',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: DAI_ADDR,
        functionSignature: 'paused()',
        conditions: [{ field: 'result', operator: '==', value: 'true' }],
        resultField: 'result',
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));
    expect(result).not.toBeNull();
  });

  // --- 8. Multiple conditions on return values ---
  it('requires all conditions to pass on return values', async () => {
    const event = makeEvent({
      eventType: 'chain.view_call_result',
      payload: {
        contractAddress: DAI_ADDR,
        functionName: 'getReserves',
        returnValues: {
          reserve0: '5000000000000000000000',
          reserve1: '10000000000',
        },
        blockNumber: '19000006',
      },
    });
    const rule = makeRule({
      ruleType: 'chain.view_call',
      config: {
        contractAddress: DAI_ADDR,
        functionSignature: 'getReserves()',
        conditions: [
          { field: 'reserve0', operator: '>', value: '1000000000000000000000' },
          { field: 'reserve1', operator: '>', value: '50000000000' }, // fails: 10B < 50B
        ],
      },
    });
    const result = await viewCallEvaluator.evaluate(makeCtx(event, rule));
    expect(result).toBeNull();
  });
});

// ===========================================================================
// 8. WINDOWED SUM EVALUATOR (11 tests)
// ===========================================================================

describe('windowedSumEvaluator', () => {
  // --- 1. Sum of transfer values exceeds 1M ETH ---
  it('triggers when sum of transfer values exceeds threshold', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:500000000000000000000000`,  // 500k ETH
        `evt-2:600000000000000000000000`,  // 600k ETH
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '600000000000000000000000' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: ONE_MILLION_ETH,
        operator: 'gt',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.type).toBe('windowed-sum');
    expect(result!.triggerType).toBe('windowed');
  });

  // --- 2. Sum below threshold - no alert ---
  it('returns null when sum is below threshold', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:100000000000000000000`, // 100 ETH
        `evt-2:200000000000000000000`, // 200 ETH
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '200000000000000000000' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: ONE_MILLION_ETH,
        operator: 'gt',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 3. Sum with 'gte' operator at exact threshold ---
  it('triggers with gte operator when sum equals threshold exactly', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:500000000000000000000000`,
        `evt-2:500000000000000000000000`,
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '500000000000000000000000' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: ONE_MILLION_ETH,
        operator: 'gte',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 4. Sum with 'lt' operator ---
  it('triggers with lt operator when sum is less than threshold', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:100`,
        `evt-2:200`,
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '200' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '1000',
        operator: 'lt',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 5. GroupBy field sums independently ---
  it('groups sums independently by decoded arg field', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:500000000000000000000000`,
        `evt-2:600000000000000000000000`,
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '600000000000000000000000' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: ONE_MILLION_ETH,
        operator: 'gt',
        groupByField: 'to',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.groupByField).toBe('to');
    expect(result!.triggerData.groupValue).toBe(BOB.toLowerCase());
  });

  // --- 6. Large BigInt values summing correctly ---
  it('sums large BigInt values without overflow', async () => {
    const largeVal = '57896044618658097711785492504343953926634992332820282019728792003956564819967';
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:${largeVal}`,
        `evt-2:${largeVal}`,
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: largeVal },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: largeVal, // sum of 2x should be > 1x
        operator: 'gt',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 7. Window expiry removes old values ---
  it('calls zremrangebyscore to prune stale entries', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([`evt-1:100`]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '100' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 10,
        threshold: '10000',
        operator: 'gt',
      },
    });
    await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(redis.zremrangebyscore).toHaveBeenCalled();
  });

  // --- 8. Mixed positive values ---
  it('sums multiple positive values correctly', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:100`,
        `evt-2:200`,
        `evt-3:300`,
        `evt-4:400`,
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '400' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '999', // sum = 1000 > 999
        operator: 'gt',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
    expect(result!.triggerData.sum).toBe('1000');
    expect(result!.triggerData.count).toBe(4);
  });

  // --- 9. Single large transaction exceeds threshold ---
  it('triggers on a single large transaction that exceeds threshold', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:${ONE_MILLION_ETH}`,
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: ONE_MILLION_ETH },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '500000000000000000000000', // 500k ETH
        operator: 'gt',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 10. Zero values in sum ---
  it('handles zero values in summing without error', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:0`,
        `evt-2:0`,
        `evt-3:0`,
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '0' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '1',
        operator: 'lt', // 0 < 1 => triggers
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });

  // --- 11. Returns null when sumField is missing from decodedArgs ---
  it('returns null when sumField is not present in decoded args', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '100',
        operator: 'gt',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 12. Non-numeric sumField value returns null ---
  it('returns null when sumField value is not numeric', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: 'not-a-number' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '100',
        operator: 'gt',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).toBeNull();
  });

  // --- 13. Threshold comparison with string BigInt via lte ---
  it('supports lte comparison against string BigInt threshold', async () => {
    const redis = makeMockRedis({
      zrange: vi.fn().mockResolvedValue([
        `evt-1:500`,
        `evt-2:500`,
      ]),
    });
    const event = makeEvent({
      payload: {
        topics: [TRANSFER_TOPIC0],
        address: DAI_ADDR,
        eventName: 'Transfer',
        decodedArgs: { from: ALICE, to: BOB, value: '500' },
      },
    });
    const rule = makeRule({
      ruleType: 'chain.windowed_sum',
      config: {
        topic0: TRANSFER_TOPIC0,
        sumField: 'value',
        windowMinutes: 60,
        threshold: '1000', // sum = 1000 <= 1000
        operator: 'lte',
      },
    });
    const result = await windowedSumEvaluator.evaluate({ event, rule, redis });
    expect(result).not.toBeNull();
  });
});
