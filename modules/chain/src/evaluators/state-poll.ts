import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { NETWORK_UI_FIELD, CONTRACT_UI_FIELD } from './_ui-shared.js';

// ---------------------------------------------------------------------------
// Config schema — ported from ChainAlert's StateConditionConfig
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Type of state condition */
  conditionType: z.enum(['changed', 'threshold_above', 'threshold_below', 'windowed_percent_change']),
  /** Threshold value (absolute, as string to handle large uint256 values) */
  value: z.string().optional(),
  /** For windowed_percent_change: max allowed percent deviation from rolling mean */
  percentThreshold: z.number().optional(),
  /** Number of historical snapshots used to compute the rolling mean (1-500, default 100) */
  windowSize: z.coerce.number().min(1).max(500).default(100),
});

// ---------------------------------------------------------------------------
// Redis helpers for state snapshots
// ---------------------------------------------------------------------------

function prevStateKey(ruleId: string): string {
  return `sentinel:state:prev:${ruleId}`;
}

function recentValuesKey(ruleId: string): string {
  return `sentinel:state:recent:${ruleId}`;
}

async function getPreviousState(redis: EvalContext['redis'], ruleId: string): Promise<bigint | null> {
  const raw = await redis.get(prevStateKey(ruleId));
  if (raw === null) return null;
  // Values are always stored as decimal strings by setPreviousState (via bigint.toString()).
  // Never re-interpret them as hex — a long all-digit decimal like "12345678901" would
  // otherwise be misread as a hex literal, producing a wildly wrong number (CRIT-10).
  return BigInt(raw);
}

async function setPreviousState(redis: EvalContext['redis'], ruleId: string, value: bigint): Promise<void> {
  await redis.set(prevStateKey(ruleId), value.toString());
}

/**
 * Push a new value onto the recent-values list (Redis list, capped at windowSize).
 * Returns the full list of recent values for rolling mean computation.
 */
async function pushAndGetRecentValues(
  redis: EvalContext['redis'],
  ruleId: string,
  value: bigint,
  windowSize: number,
): Promise<bigint[]> {
  const key = recentValuesKey(ruleId);

  // Push to head of list
  await redis.lpush(key, value.toString());

  // Trim to windowSize
  await redis.ltrim(key, 0, windowSize - 1);

  // Read all values
  const raw = await redis.lrange(key, 0, -1);
  return raw.map((v) => BigInt(v));
}

// ---------------------------------------------------------------------------
// Trigger context
// ---------------------------------------------------------------------------

interface TriggerContext {
  conditionType: string;
  currentValue: string;
  previousValue?: string;
  referenceValue?: string;
  percentChange?: number;
  threshold?: string;
  direction?: 'drop' | 'rise' | 'change';
}

interface EvalResult {
  triggered: boolean;
  context?: TriggerContext;
}

// ---------------------------------------------------------------------------
// Pure state condition evaluator — faithfully ported from ChainAlert
// ---------------------------------------------------------------------------

function evaluateStateCondition(
  conditionType: string,
  currentValue: bigint,
  previousValue: bigint | null,
  thresholdValue: bigint | undefined,
  percentThreshold: number | undefined,
  recentValues?: bigint[],
): EvalResult {
  switch (conditionType) {
    case 'changed':
      if (previousValue === null) return { triggered: false };
      if (currentValue !== previousValue) {
        return {
          triggered: true,
          context: {
            conditionType: 'changed',
            currentValue: currentValue.toString(),
            previousValue: previousValue.toString(),
            direction: 'change',
          },
        };
      }
      return { triggered: false };

    case 'threshold_above':
      if (thresholdValue === undefined) return { triggered: false };
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
      if (thresholdValue === undefined) return { triggered: false };
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

    case 'windowed_percent_change': {
      if (!recentValues || recentValues.length < 2) return { triggered: false };
      if (percentThreshold === undefined) return { triggered: false };

      // Compute rolling mean from PREVIOUS values only (exclude current value
      // which is at index 0 since we lpush to the head of the list)
      const previousValues = recentValues.slice(1);
      if (previousValues.length === 0) return { triggered: false };
      const sum = previousValues.reduce((a, b) => a + b, 0n);
      const mean = sum / BigInt(previousValues.length);
      if (mean === 0n) return { triggered: false };

      // Compute absolute percent deviation from mean
      const diff = currentValue > mean ? currentValue - mean : mean - currentValue;
      const percentDeviation = Number((diff * 100n) / mean);

      if (percentDeviation >= percentThreshold) {
        return {
          triggered: true,
          context: {
            conditionType: 'windowed_percent_change',
            currentValue: currentValue.toString(),
            referenceValue: mean.toString(),
            percentChange: currentValue > mean ? percentDeviation : -percentDeviation,
            threshold: percentThreshold.toString(),
            direction: currentValue > mean ? 'rise' : 'drop',
          },
        };
      }
      return { triggered: false };
    }

    default:
      return { triggered: false };
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const statePollEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.state_poll',
  configSchema,
  uiSchema: [
    NETWORK_UI_FIELD,
    CONTRACT_UI_FIELD,
    { key: 'conditionType', label: 'Condition type', type: 'select', required: true, options: [{ value: 'changed', label: 'Any change' }, { value: 'threshold_above', label: 'Above threshold' }, { value: 'threshold_below', label: 'Below threshold' }, { value: 'windowed_percent_change', label: 'Percent change over window' }] },
    { key: 'value', label: 'Threshold value', type: 'text', required: false, help: 'Required for threshold_above / threshold_below conditions.' },
    { key: 'percentThreshold', label: 'Percent threshold', type: 'number', required: false, help: 'Required for windowed_percent_change.' },
    { key: 'windowSize', label: 'Window size (blocks)', type: 'number', required: false, min: 1, max: 500, placeholder: '100' },
  ],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule, redis } = ctx;

    // Handle state snapshot events (storage slot reads)
    if (event.eventType !== 'chain.state_snapshot') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      address: string;
      slot?: string;
      value: string;
      blockNumber?: string;
    };

    const raw = payload.value;
    // BigInt() natively handles both 0x-prefixed hex strings (e.g. "0x1a2b…") and
    // plain decimal strings.  The old regex `/^[0-9a-fA-F]+$/` incorrectly matched
    // pure decimal strings (digits are valid hex chars) and prepended "0x", turning
    // e.g. decimal "12345678901" into hex 0x12345678901 = 78,187,493,121 (CRIT-10).
    const currentValue = BigInt(raw);
    const thresholdValue = config.value !== undefined ? BigInt(config.value) : undefined;

    // Retrieve previous state value from Redis
    const previousValue = await getPreviousState(redis, rule.id);

    // For windowed_percent_change, maintain a rolling list of recent values
    let recentValues: bigint[] | undefined;
    if (config.conditionType === 'windowed_percent_change') {
      recentValues = await pushAndGetRecentValues(redis, rule.id, currentValue, config.windowSize);
    }

    // Update stored previous state
    await setPreviousState(redis, rule.id, currentValue);

    // Evaluate the condition
    const result = evaluateStateCondition(
      config.conditionType,
      currentValue,
      previousValue,
      thresholdValue,
      config.percentThreshold,
      recentValues,
    );

    if (!result.triggered || !result.context) return null;

    const slotLabel = payload.slot ? `slot ${payload.slot}` : 'state';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `State ${result.context.conditionType} on ${payload.address} (${slotLabel})`,
      description: buildDescription(result.context, payload.address, slotLabel),
      triggerType: 'deferred',
      triggerData: {
        type: 'state-poll',
        address: payload.address,
        slot: payload.slot,
        blockNumber: payload.blockNumber,
        ...result.context,
      },
    };
  },
};

function buildDescription(ctx: TriggerContext, address: string, slotLabel: string): string {
  switch (ctx.conditionType) {
    case 'changed':
      return `Storage ${slotLabel} of ${address} changed from ${ctx.previousValue} to ${ctx.currentValue}.`;
    case 'threshold_above':
      return `Storage ${slotLabel} of ${address} is ${ctx.currentValue}, above threshold ${ctx.threshold}.`;
    case 'threshold_below':
      return `Storage ${slotLabel} of ${address} is ${ctx.currentValue}, below threshold ${ctx.threshold}.`;
    case 'windowed_percent_change':
      return `Storage ${slotLabel} of ${address} deviated ${ctx.percentChange?.toFixed(2)}% from rolling mean (${ctx.referenceValue}). Current: ${ctx.currentValue}.`;
    default:
      return `State condition ${ctx.conditionType} triggered on ${address} (${slotLabel}).`;
  }
}
