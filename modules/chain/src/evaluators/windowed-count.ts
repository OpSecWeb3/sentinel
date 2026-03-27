import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { NETWORK_UI_FIELD, CONTRACT_UI_FIELD, EVENT_SIG_UI_FIELD, GROUP_BY_UI_FIELD } from './_ui-shared.js';

// ---------------------------------------------------------------------------
// Config schema — ported from ChainAlert's windowed-count rule config
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Event signature to match, e.g. "Transfer(address,address,uint256)" */
  eventSignature: z.string().optional(),
  /** Pre-computed topic0 */
  topic0: z.string().optional(),
  /** Optional contract address filter */
  contractAddress: z.string().optional(),
  /** Sliding window duration in minutes */
  windowMinutes: z.coerce.number().default(60),
  /** Threshold count that must be reached or exceeded to trigger */
  threshold: z.coerce.number().default(5),
  /** Decoded arg field name to group counts by (e.g. "to" for per-recipient) */
  groupByField: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Redis key helpers — ported from ChainAlert's windowed.ts
// ---------------------------------------------------------------------------

function windowKey(ruleId: string, groupValue?: string): string {
  if (groupValue) {
    return `sentinel:wcount:${ruleId}:${groupValue}`;
  }
  return `sentinel:window:${ruleId}`;
}

// ---------------------------------------------------------------------------
// Core windowed-count logic — faithfully ported from ChainAlert
//
// Each rule maintains a Redis sorted set. Members are event IDs; scores are
// Unix-ms timestamps. On each incoming event:
//   1. Add the event to the sorted set
//   2. Prune entries older than the window
//   3. Count remaining entries
//   4. Trigger if count >= threshold
// ---------------------------------------------------------------------------

async function checkWindowThreshold(
  redis: EvalContext['redis'],
  ruleId: string,
  eventId: string,
  _timestamp: number,
  windowMs: number,
  threshold: number,
): Promise<boolean> {
  const key = windowKey(ruleId);
  const now = Date.now();

  // 1. Add the new event (use Date.now() for both add and prune to avoid
  //    timestamp mismatch between block timestamps and wall-clock pruning)
  await redis.zadd(key, now, eventId);

  // 2. Prune stale entries outside the window
  const cutoff = now - windowMs;
  await redis.zremrangebyscore(key, '-inf', cutoff);

  // 3. Count remaining entries
  const count = await redis.zcard(key);

  // 4. Set TTL on ungrouped keys so they don't leak forever in Redis
  await redis.pexpire(key, windowMs);

  return count >= threshold;
}

async function checkGroupedWindowThreshold(
  redis: EvalContext['redis'],
  ruleId: string,
  groupValue: string,
  eventId: string,
  _timestamp: number,
  windowMs: number,
  threshold: number,
): Promise<{ triggered: boolean; count: number }> {
  const key = windowKey(ruleId, groupValue);
  const now = Date.now();

  // 1. Add the new event to the group's sorted set (use Date.now() for
  //    consistency between add and prune operations)
  await redis.zadd(key, now, eventId);

  // 2. Prune stale entries outside the window
  const cutoff = now - windowMs;
  await redis.zremrangebyscore(key, '-inf', cutoff);

  // 3. Count remaining entries
  const count = await redis.zcard(key);

  // 4. Set TTL = window duration so the key auto-expires if no new events
  await redis.pexpire(key, windowMs);

  return { triggered: count >= threshold, count };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const windowedCountEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.windowed_count',
  configSchema,
  uiSchema: [
    NETWORK_UI_FIELD,
    CONTRACT_UI_FIELD,
    EVENT_SIG_UI_FIELD,
    { key: 'windowMinutes', label: 'Time window (minutes)', type: 'number', required: true, default: 60, min: 1, help: 'Count events within this rolling window.' },
    { key: 'threshold', label: 'Alert threshold (count)', type: 'number', required: true, default: 5, min: 1, help: 'Alert when event count reaches this value.' },
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

    // ----- windowed threshold check -----
    const windowMs = config.windowMinutes * 60_000;
    const timestamp = event.occurredAt.getTime();

    if (config.groupByField) {
      const args = payload.decodedArgs ?? {};
      const groupValue = String(args[config.groupByField] ?? '').toLowerCase();

      const { triggered, count } = await checkGroupedWindowThreshold(
        redis,
        rule.id,
        groupValue,
        event.id,
        timestamp,
        windowMs,
        config.threshold,
      );

      if (!triggered) return null;

      const eventName = payload.eventName ?? 'UnknownEvent';
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'high',
        title: `${eventName}: ${count} events in ${config.windowMinutes}m for ${config.groupByField}="${groupValue}"`,
        description: `Windowed count threshold reached: ${count}>=${config.threshold} events within ${config.windowMinutes} minutes, grouped by ${config.groupByField}="${groupValue}"`,
        triggerType: 'windowed',
        triggerData: {
          type: 'windowed-count',
          eventName,
          contractAddress: payload.address,
          blockNumber: payload.blockNumber,
          transactionHash: payload.transactionHash,
          windowMinutes: config.windowMinutes,
          threshold: config.threshold,
          count,
          groupByField: config.groupByField,
          groupValue,
        },
      };
    }

    // Ungrouped variant
    const triggered = await checkWindowThreshold(
      redis,
      rule.id,
      event.id,
      timestamp,
      windowMs,
      config.threshold,
    );

    if (!triggered) return null;

    const eventName = payload.eventName ?? 'UnknownEvent';
    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `${eventName}: windowed count threshold reached (>=${config.threshold} in ${config.windowMinutes}m)`,
      description: `Windowed count threshold reached: >=${config.threshold} events within ${config.windowMinutes} minutes`,
      triggerType: 'windowed',
      triggerData: {
        type: 'windowed-count',
        eventName,
        contractAddress: payload.address,
        blockNumber: payload.blockNumber,
        transactionHash: payload.transactionHash,
        windowMinutes: config.windowMinutes,
        threshold: config.threshold,
      },
    };
  },
};
