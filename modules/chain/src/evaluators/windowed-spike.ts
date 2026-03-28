import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { NETWORK_UI_FIELD, CONTRACT_UI_FIELD, EVENT_SIG_UI_FIELD, GROUP_BY_UI_FIELD } from './_ui-shared.js';

// ---------------------------------------------------------------------------
// Config schema — ported from ChainAlert's windowed-spike rule config
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Event signature to match */
  eventSignature: z.string().optional(),
  /** Pre-computed topic0 */
  topic0: z.string().optional(),
  /** Optional contract address filter */
  contractAddress: z.string().optional(),
  /** Observation (recent) window in minutes */
  observationMinutes: z.coerce.number().default(5),
  /** Baseline (historical) window in minutes */
  baselineMinutes: z.coerce.number().default(60),
  /** Minimum percentage increase over baseline average to trigger */
  increasePercent: z.coerce.number().default(200),
  /** Minimum number of events in the baseline for a valid comparison */
  minBaselineCount: z.coerce.number().default(3),
  /** Decoded arg field name to group spike detection by */
  groupByField: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Redis key helper
// ---------------------------------------------------------------------------

function windowKey(ruleId: string, groupValue?: string): string {
  if (groupValue) {
    return `sentinel:wspike:${ruleId}:${groupValue}`;
  }
  return `sentinel:wspike:${ruleId}`;
}

// ---------------------------------------------------------------------------
// Spike result type — mirrors ChainAlert's SpikeResult
// ---------------------------------------------------------------------------

interface SpikeResult {
  triggered: boolean;
  currentCount: number;
  baselineAvg: number;
  spikePercent: number;
}

// ---------------------------------------------------------------------------
// Core spike detection logic — faithfully ported from ChainAlert
//
//   baseline window                          observation window
//   +--------------------------------------++-------------+
//                                                          ^ now
//
//   baseline_avg = baseline_count / (baselineMs / observationMs)
//   spike%       = ((current - baseline_avg) / baseline_avg) * 100
//   trigger      = spike% >= increasePercent AND baseline_count >= minBaselineCount
// ---------------------------------------------------------------------------

async function checkWindowSpikeThreshold(
  redis: EvalContext['redis'],
  ruleId: string,
  eventId: string,
  _timestamp: number,
  observationMs: number,
  baselineMs: number,
  increasePercent: number,
  minBaselineCount: number,
): Promise<SpikeResult> {
  const key = windowKey(ruleId);
  const now = Date.now();

  // 1. Add the new event using wall-clock time so that add and prune
  //    operate on the same time domain. Using block timestamps here would
  //    cause catch-up events (whose timestamps are in the past) to be
  //    immediately pruned by the wall-clock cutoff below, silently
  //    dropping them from both the observation and baseline windows.
  await redis.zadd(key, now, eventId);

  // 2. Prune entries older than the full baseline window
  await redis.zremrangebyscore(key, '-inf', now - baselineMs);

  // 3. Count events in the observation window (recent)
  const currentCount = await redis.zcount(key, now - observationMs, '+inf');

  // 4. Count events in the baseline-only portion (before observation window)
  const baselineCount = await redis.zcount(key, now - baselineMs, now - observationMs);

  // Not enough baseline data to judge
  if (baselineCount < minBaselineCount) {
    return { triggered: false, currentCount, baselineAvg: 0, spikePercent: 0 };
  }

  // 5. Compute baseline average rate (events per observation window)
  const baselineAvg = baselineCount / (baselineMs / observationMs);

  // 6. Compute spike percentage
  const spikePercent = baselineAvg > 0 ? ((currentCount - baselineAvg) / baselineAvg) * 100 : 0;

  // Set TTL = baselineMs so the key auto-expires if no new events arrive
  await redis.pexpire(key, baselineMs);

  return {
    triggered: spikePercent >= increasePercent,
    currentCount,
    baselineAvg,
    spikePercent,
  };
}

async function checkGroupedWindowSpikeThreshold(
  redis: EvalContext['redis'],
  ruleId: string,
  groupValue: string,
  eventId: string,
  _timestamp: number,
  observationMs: number,
  baselineMs: number,
  increasePercent: number,
  minBaselineCount: number,
): Promise<SpikeResult> {
  const key = windowKey(ruleId, groupValue);
  const now = Date.now();

  // 1. Add the new event using wall-clock time (same reasoning as the
  //    ungrouped variant above — block timestamps and wall-clock pruning
  //    must not be mixed).
  await redis.zadd(key, now, eventId);

  // 2. Prune entries older than the full baseline window
  await redis.zremrangebyscore(key, '-inf', now - baselineMs);

  // 3. Count events in the observation window
  const currentCount = await redis.zcount(key, now - observationMs, '+inf');

  // 4. Count events in the baseline-only portion
  const baselineCount = await redis.zcount(key, now - baselineMs, now - observationMs);

  // Not enough baseline data
  if (baselineCount < minBaselineCount) {
    return { triggered: false, currentCount, baselineAvg: 0, spikePercent: 0 };
  }

  // 5. Compute baseline average rate
  const baselineAvg = baselineCount / (baselineMs / observationMs);

  // 6. Compute spike percentage
  const spikePercent = baselineAvg > 0 ? ((currentCount - baselineAvg) / baselineAvg) * 100 : 0;

  // 7. Set TTL = baselineMs so the key auto-expires if no new events arrive
  await redis.pexpire(key, baselineMs);

  return {
    triggered: spikePercent >= increasePercent,
    currentCount,
    baselineAvg,
    spikePercent,
  };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const windowedSpikeEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.windowed_spike',
  configSchema,
  uiSchema: [
    NETWORK_UI_FIELD,
    CONTRACT_UI_FIELD,
    EVENT_SIG_UI_FIELD,
    { key: 'observationMinutes', label: 'Observation window (min)', type: 'number', required: true, default: 5, min: 1 },
    { key: 'baselineMinutes', label: 'Baseline window (min)', type: 'number', required: true, default: 60, min: 1 },
    { key: 'increasePercent', label: 'Rate increase % to alert', type: 'number', required: true, default: 200, min: 1 },
    { key: 'minBaselineCount', label: 'Minimum baseline count', type: 'number', required: false, default: 3, min: 1, help: 'Skip alert if baseline count is too low to be meaningful.' },
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

    // ----- spike detection -----
    const observationMs = config.observationMinutes * 60_000;
    const baselineMs = config.baselineMinutes * 60_000;
    const timestamp = event.occurredAt.getTime();

    if (config.groupByField) {
      const args = payload.decodedArgs ?? {};
      const groupValue = String(args[config.groupByField] ?? '').toLowerCase();

      const result = await checkGroupedWindowSpikeThreshold(
        redis,
        rule.id,
        groupValue,
        event.id,
        timestamp,
        observationMs,
        baselineMs,
        config.increasePercent,
        config.minBaselineCount,
      );

      if (!result.triggered) return null;

      const eventName = payload.eventName ?? 'UnknownEvent';
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'critical',
        title: `${eventName}: rate spike ${result.spikePercent.toFixed(0)}% for ${config.groupByField}="${groupValue}"`,
        description: `Event rate spike detected: ${result.spikePercent.toFixed(0)}% increase over baseline average (${result.baselineAvg.toFixed(1)} events per ${config.observationMinutes}m window). Grouped by ${config.groupByField}="${groupValue}".`,
        triggerType: 'windowed',
        triggerData: {
          type: 'windowed-spike',
          eventName,
          contractAddress: payload.address,
          blockNumber: payload.blockNumber,
          transactionHash: payload.transactionHash,
          observationMinutes: config.observationMinutes,
          baselineMinutes: config.baselineMinutes,
          increasePercent: config.increasePercent,
          currentCount: result.currentCount,
          baselineAvg: result.baselineAvg,
          spikePercent: result.spikePercent,
          groupByField: config.groupByField,
          groupValue,
        },
      };
    }

    // Ungrouped variant
    const result = await checkWindowSpikeThreshold(
      redis,
      rule.id,
      event.id,
      timestamp,
      observationMs,
      baselineMs,
      config.increasePercent,
      config.minBaselineCount,
    );

    if (!result.triggered) return null;

    const eventName = payload.eventName ?? 'UnknownEvent';
    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'critical',
      title: `${eventName}: rate spike ${result.spikePercent.toFixed(0)}% detected`,
      description: `Event rate spike detected: ${result.spikePercent.toFixed(0)}% increase over baseline average (${result.baselineAvg.toFixed(1)} events per ${config.observationMinutes}m window).`,
      triggerType: 'windowed',
      triggerData: {
        type: 'windowed-spike',
        eventName,
        contractAddress: payload.address,
        blockNumber: payload.blockNumber,
        transactionHash: payload.transactionHash,
        observationMinutes: config.observationMinutes,
        baselineMinutes: config.baselineMinutes,
        increasePercent: config.increasePercent,
        currentCount: result.currentCount,
        baselineAvg: result.baselineAvg,
        spikePercent: result.spikePercent,
      },
    };
  },
};
