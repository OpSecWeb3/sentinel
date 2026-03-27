import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { NETWORK_UI_FIELD, CONTRACT_UI_FIELD } from './_ui-shared.js';

// ---------------------------------------------------------------------------
// Config schema — ported from ChainAlert's BalanceConditionConfig
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Type of balance condition */
  conditionType: z.enum(['percent_change', 'threshold_above', 'threshold_below']),
  /** Threshold value: percentage (0-100) for percent_change, absolute wei string for threshold */
  value: z.string(),
  /** Rolling window in milliseconds for windowed percent_change comparisons */
  windowMs: z.number().optional(),
  /** When true, windowed percent_change triggers on both drops and rises (default: drops only) */
  bidirectional: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Redis helpers for previous-value storage — ported from ChainAlert evaluator
// ---------------------------------------------------------------------------

function prevValueKey(ruleId: string): string {
  return `sentinel:prev:${ruleId}`;
}

function snapshotKey(ruleId: string): string {
  return `sentinel:balsnapshots:${ruleId}`;
}

async function getPreviousValue(redis: EvalContext['redis'], ruleId: string): Promise<bigint | null> {
  const raw = await redis.get(prevValueKey(ruleId));
  if (raw === null) return null;
  return BigInt(raw);
}

async function setPreviousValue(redis: EvalContext['redis'], ruleId: string, value: bigint): Promise<void> {
  await redis.set(prevValueKey(ruleId), value.toString());
}

/**
 * Retrieve windowed snapshots from a Redis sorted set.
 * Members are "{timestamp}:{value}" strings; scores are Unix-ms timestamps.
 * This format avoids dedup issues where identical balance values would
 * collapse into a single sorted set member.
 */
async function getWindowedSnapshots(
  redis: EvalContext['redis'],
  ruleId: string,
  windowMs: number,
): Promise<bigint[]> {
  const key = snapshotKey(ruleId);
  const cutoff = Date.now() - windowMs;

  // Prune old entries
  await redis.zremrangebyscore(key, '-inf', cutoff);

  // Fetch remaining members ("{timestamp}:{value}" strings)
  const members = await redis.zrangebyscore(key, cutoff, '+inf');
  return members.map((m) => {
    // Parse value from "{timestamp}:{value}" format
    const colonIdx = m.indexOf(':');
    const valuePart = colonIdx >= 0 ? m.slice(colonIdx + 1) : m;
    return BigInt(valuePart);
  });
}

async function addSnapshot(
  redis: EvalContext['redis'],
  ruleId: string,
  value: bigint,
  windowMs: number,
): Promise<void> {
  const key = snapshotKey(ruleId);
  const now = Date.now();
  // Use "{timestamp}:{value}" as member to avoid dedup of identical values
  await redis.zadd(key, now, `${now}:${value.toString()}`);
  // Auto-expire so we don't leak memory
  await redis.pexpire(key, windowMs * 2);
}

// ---------------------------------------------------------------------------
// Trigger context — matches ChainAlert's TriggerContext shape
// ---------------------------------------------------------------------------

interface TriggerContext {
  conditionType: string;
  currentValue: string;
  previousValue?: string;
  referenceValue?: string;
  percentChange?: number;
  threshold?: string;
  windowMs?: number;
  direction?: 'drop' | 'rise' | 'change';
}

interface EvalResult {
  triggered: boolean;
  context?: TriggerContext;
}

// ---------------------------------------------------------------------------
// Pure balance condition evaluator — faithfully ported from ChainAlert
// ---------------------------------------------------------------------------

function evaluateBalanceConditionPure(
  conditionType: string,
  thresholdValue: bigint,
  currentValue: bigint,
  previousValue: bigint | null,
  windowMs: number | undefined,
  bidirectional: boolean,
  windowedSnapshots?: bigint[],
): EvalResult {
  switch (conditionType) {
    case 'percent_change': {
      // --- Windowed comparison ------------------------------------------------
      if (windowMs && windowedSnapshots && windowedSnapshots.length > 0) {
        let maxInWindow = windowedSnapshots[0]!;
        let minInWindow = windowedSnapshots[0]!;
        for (let i = 1; i < windowedSnapshots.length; i++) {
          if (windowedSnapshots[i]! > maxInWindow) maxInWindow = windowedSnapshots[i]!;
          if (windowedSnapshots[i]! < minInWindow) minInWindow = windowedSnapshots[i]!;
        }

        const thresholdBps = thresholdValue * 100n;

        // Drop from peak
        if (maxInWindow > 0n && currentValue < maxInWindow) {
          const dropBps = ((maxInWindow - currentValue) * 10000n) / maxInWindow;
          if (dropBps >= thresholdBps) {
            return {
              triggered: true,
              context: {
                conditionType: 'percent_change',
                currentValue: currentValue.toString(),
                referenceValue: maxInWindow.toString(),
                percentChange: -Number(dropBps) / 100,
                threshold: thresholdValue.toString(),
                windowMs,
                direction: 'drop',
              },
            };
          }
        }

        // Rise from trough (bidirectional only)
        if (bidirectional && minInWindow > 0n && currentValue > minInWindow) {
          const riseBps = ((currentValue - minInWindow) * 10000n) / minInWindow;
          if (riseBps >= thresholdBps) {
            return {
              triggered: true,
              context: {
                conditionType: 'percent_change',
                currentValue: currentValue.toString(),
                referenceValue: minInWindow.toString(),
                percentChange: Number(riseBps) / 100,
                threshold: thresholdValue.toString(),
                windowMs,
                direction: 'rise',
              },
            };
          }
        }

        return { triggered: false };
      }

      // --- Non-windowed (previous-vs-current) --------------------------------
      if (previousValue === null || previousValue === 0n) return { triggered: false };
      const diff = currentValue > previousValue
        ? currentValue - previousValue
        : previousValue - currentValue;
      const bps = (diff * 10000n) / previousValue;
      if (bps >= thresholdValue * 100n) {
        const direction = currentValue < previousValue ? 'drop' : 'rise';
        return {
          triggered: true,
          context: {
            conditionType: 'percent_change',
            currentValue: currentValue.toString(),
            previousValue: previousValue.toString(),
            percentChange: direction === 'drop' ? -Number(bps) / 100 : Number(bps) / 100,
            threshold: thresholdValue.toString(),
            direction,
          },
        };
      }
      return { triggered: false };
    }

    case 'threshold_above':
      if (currentValue > thresholdValue) {
        return {
          triggered: true,
          context: {
            conditionType: 'threshold_above',
            currentValue: currentValue.toString(),
            previousValue: previousValue?.toString(),
            threshold: thresholdValue.toString(),
          },
        };
      }
      return { triggered: false };

    case 'threshold_below':
      if (currentValue < thresholdValue) {
        return {
          triggered: true,
          context: {
            conditionType: 'threshold_below',
            currentValue: currentValue.toString(),
            previousValue: previousValue?.toString(),
            threshold: thresholdValue.toString(),
          },
        };
      }
      return { triggered: false };

    default:
      return { triggered: false };
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const balanceTrackEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.balance_track',
  configSchema,
  uiSchema: [
    NETWORK_UI_FIELD,
    CONTRACT_UI_FIELD,
    { key: 'conditionType', label: 'Condition type', type: 'select', required: true, options: [{ value: 'percent_change', label: 'Balance changes by %' }, { value: 'threshold_above', label: 'Balance exceeds threshold' }, { value: 'threshold_below', label: 'Balance drops below threshold' }] },
    { key: 'value', label: 'Threshold / percent', type: 'text', required: true, placeholder: '1000000000000000000', help: 'Amount in wei, or percent (e.g. 20 for 20%).' },
    { key: 'windowMs', label: 'Window (ms)', type: 'number', required: false, placeholder: '3600000', help: 'Time window in milliseconds for percent_change condition.' },
    { key: 'bidirectional', label: 'Alert on increase too', type: 'boolean', required: false },
  ],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule, redis } = ctx;

    // Handle balance snapshot events
    if (event.eventType !== 'chain.balance_snapshot') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      address: string;
      tokenAddress?: string;
      balance: string;
      blockNumber?: string;
    };

    const currentValue = BigInt(payload.balance);
    const thresholdValue = BigInt(config.value);

    // Retrieve previous value from Redis
    const previousValue = await getPreviousValue(redis, rule.id);

    // Store windowed snapshot if windowed mode
    let windowedSnapshots: bigint[] | undefined;
    if (config.windowMs) {
      await addSnapshot(redis, rule.id, currentValue, config.windowMs);
      windowedSnapshots = await getWindowedSnapshots(redis, rule.id, config.windowMs);
    }

    // Update stored previous value
    await setPreviousValue(redis, rule.id, currentValue);

    // Evaluate the condition
    const result = evaluateBalanceConditionPure(
      config.conditionType,
      thresholdValue,
      currentValue,
      previousValue,
      config.windowMs,
      config.bidirectional,
      windowedSnapshots,
    );

    if (!result.triggered || !result.context) return null;

    const tokenLabel = payload.tokenAddress
      ? `token ${payload.tokenAddress}`
      : 'native balance';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `Balance alert: ${result.context.conditionType} on ${payload.address} (${tokenLabel})`,
      description: buildDescription(result.context, payload.address, tokenLabel),
      triggerType: 'immediate',
      triggerData: {
        type: 'balance-track',
        address: payload.address,
        tokenAddress: payload.tokenAddress,
        blockNumber: payload.blockNumber,
        ...result.context,
      },
    };
  },
};

function buildDescription(ctx: TriggerContext, address: string, tokenLabel: string): string {
  switch (ctx.conditionType) {
    case 'percent_change':
      return `Balance of ${address} (${tokenLabel}) changed ${ctx.percentChange?.toFixed(2)}% (${ctx.direction}). Current: ${ctx.currentValue}, reference: ${ctx.referenceValue ?? ctx.previousValue ?? 'N/A'}.`;
    case 'threshold_above':
      return `Balance of ${address} (${tokenLabel}) is ${ctx.currentValue}, above threshold ${ctx.threshold}.`;
    case 'threshold_below':
      return `Balance of ${address} (${tokenLabel}) is ${ctx.currentValue}, below threshold ${ctx.threshold}.`;
    default:
      return `Balance condition ${ctx.conditionType} triggered on ${address}.`;
  }
}
