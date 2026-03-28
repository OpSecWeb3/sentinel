import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { NETWORK_UI_FIELD, CONTRACT_UI_FIELD, EVENT_SIG_UI_FIELD, GROUP_BY_UI_FIELD } from './_ui-shared.js';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Event signature to match, e.g. "Transfer(address,address,uint256)" */
  eventSignature: z.string().optional(),
  /** Pre-computed topic0 */
  topic0: z.string().optional(),
  /** Optional contract address filter */
  contractAddress: z.string().optional(),
  /** Decoded arg field whose value to sum (e.g. "value", "amount") */
  sumField: z.string(),
  /** Sliding window duration in minutes */
  windowMinutes: z.coerce.number().positive().default(60),
  /** BigInt-compatible threshold string (e.g. "1000000000000000000" for 1 ETH) */
  threshold: z.string(),
  /** Comparison operator for sum vs threshold */
  operator: z.enum(['gt', 'gte', 'lt', 'lte']).default('gt'),
  /** Decoded arg field name to group sums by (e.g. "to" for per-recipient) */
  groupByField: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

function sumKey(orgId: string, ruleId: string, groupValue?: string): string {
  if (groupValue) {
    return `sentinel:wsum:${orgId}:${ruleId}:${groupValue}`;
  }
  return `sentinel:wsum:${orgId}:${ruleId}`;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function compare(sum: bigint, threshold: bigint, op: string): boolean {
  switch (op) {
    case 'gt': return sum > threshold;
    case 'gte': return sum >= threshold;
    case 'lt': return sum < threshold;
    case 'lte': return sum <= threshold;
    default: return sum > threshold;
  }
}

// ---------------------------------------------------------------------------
// Core windowed-sum logic
//
// Same Redis sorted set pattern as windowed-count, but members encode the
// numeric value alongside the event ID. On each event:
//   1. Add the event with its value to the sorted set
//   2. Prune entries older than the window
//   3. Fetch all remaining members, parse values, sum them
//   4. Trigger if sum meets the threshold condition
// ---------------------------------------------------------------------------

async function checkWindowedSum(
  redis: EvalContext['redis'],
  orgId: string,
  ruleId: string,
  eventId: string,
  value: string,
  windowMs: number,
  threshold: bigint,
  operator: string,
  groupValue?: string,
): Promise<{ triggered: boolean; sum: bigint; count: number }> {
  const key = sumKey(orgId, ruleId, groupValue);
  const now = Date.now();

  // Member format: "eventId:value" — value is the raw bigint string
  const member = `${eventId}:${value}`;

  // 1. Add the new event
  await redis.zadd(key, now, member);

  // 2. Prune stale entries
  const cutoff = now - windowMs;
  await redis.zremrangebyscore(key, '-inf', cutoff);

  // 3. Fetch only members still within the window and sum their values
  const members = await redis.zrangebyscore(key, cutoff, '+inf');
  let sum = 0n;
  for (const m of members) {
    const colonIdx = m.lastIndexOf(':');
    if (colonIdx > 0) {
      try {
        sum += BigInt(m.slice(colonIdx + 1));
      } catch {
        // Skip malformed members
      }
    }
  }

  // 4. Set TTL so the key auto-expires if no new events
  await redis.pexpire(key, windowMs);

  return {
    triggered: compare(sum, threshold, operator),
    sum,
    count: members.length,
  };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const windowedSumEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.windowed_sum',
  configSchema,
  uiSchema: [
    NETWORK_UI_FIELD,
    CONTRACT_UI_FIELD,
    EVENT_SIG_UI_FIELD,
    { key: 'sumField', label: 'Field to sum', type: 'text', required: true, placeholder: 'value', help: 'Event payload field whose values are summed (e.g. "value" for ERC-20 amount).' },
    { key: 'windowMinutes', label: 'Time window (minutes)', type: 'number', required: true, default: 60, min: 1 },
    { key: 'threshold', label: 'Sum threshold (wei)', type: 'text', required: true, placeholder: '1000000000000000000', help: 'Alert when total sum in window exceeds this.' },
    { key: 'operator', label: 'Operator', type: 'select', required: false, options: [{ value: 'gt', label: '> greater than' }, { value: 'gte', label: '>= greater or equal' }, { value: 'lt', label: '< less than' }, { value: 'lte', label: '<= less or equal' }] },
    GROUP_BY_UI_FIELD,
  ],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule, redis } = ctx;

    // Only handle on-chain log events
    if (event.eventType !== 'chain.log') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      topics: string[];
      address: string;
      decodedArgs?: Record<string, unknown>;
      eventName?: string;
      blockNumber?: string;
      transactionHash?: string;
    };

    // ----- topic0 matching -----
    const logTopic0 = payload.topics?.[0]?.toLowerCase();
    if (!logTopic0) return null;

    const ruleTopic0 = (config.topic0 ?? '').toLowerCase();
    if (!ruleTopic0) return null;
    if (logTopic0 !== ruleTopic0) return null;

    // ----- contract address filter -----
    if (config.contractAddress) {
      if (payload.address.toLowerCase() !== config.contractAddress.toLowerCase()) {
        return null;
      }
    }

    // ----- extract the sum field value -----
    const args = payload.decodedArgs ?? {};
    const rawValue = args[config.sumField];
    if (rawValue === undefined || rawValue === null) return null;

    const valueStr = String(rawValue);
    let valueBigInt: bigint;
    try {
      valueBigInt = BigInt(valueStr);
    } catch {
      return null; // Non-numeric field
    }

    // ----- windowed sum check -----
    const windowMs = config.windowMinutes * 60_000;
    const thresholdBigInt = BigInt(config.threshold);
    const groupValue = config.groupByField
      ? String(args[config.groupByField] ?? '').toLowerCase()
      : undefined;

    const { triggered, sum, count } = await checkWindowedSum(
      redis,
      event.orgId,
      rule.id,
      event.id,
      valueStr,
      windowMs,
      thresholdBigInt,
      config.operator,
      groupValue,
    );

    if (!triggered) return null;

    const eventName = payload.eventName ?? 'UnknownEvent';
    const groupSuffix = config.groupByField && groupValue
      ? ` for ${config.groupByField}="${groupValue}"`
      : '';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `${eventName}: windowed sum ${config.operator} ${config.threshold} in ${config.windowMinutes}m${groupSuffix}`,
      description: `Windowed sum threshold reached: sum of ${config.sumField} = ${sum.toString()} (${config.operator} ${config.threshold}) across ${count} events within ${config.windowMinutes} minutes${groupSuffix}`,
      triggerType: 'windowed',
      triggerData: {
        type: 'windowed-sum',
        eventName,
        contractAddress: payload.address,
        blockNumber: payload.blockNumber,
        transactionHash: payload.transactionHash,
        windowMinutes: config.windowMinutes,
        threshold: config.threshold,
        operator: config.operator,
        sumField: config.sumField,
        sum: sum.toString(),
        count,
        ...(config.groupByField && { groupByField: config.groupByField, groupValue }),
      },
    };
  },
};
