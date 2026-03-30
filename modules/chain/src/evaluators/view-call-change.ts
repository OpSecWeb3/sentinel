import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { NETWORK_UI_FIELD, CONTRACT_UI_FIELD } from './_ui-shared.js';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  contractAddress: z.string(),
  functionSignature: z.string(),
  functionName: z.string().optional(),
  /** Return value key to track. Defaults to "result" (first return value). */
  resultField: z.string().default('result'),
  /**
   * `time`      — windows defined by wall-clock duration (observationMinutes / baselineMinutes).
   *               Good when you reason in "the last N minutes".
   * `snapshots` — windows defined by reading count (observationSamples / baselineSamples).
   *               Good when you reason in "the last N poll readings" regardless of interval.
   */
  windowMode: z.enum(['time', 'snapshots']).default('time'),
  // --- time mode ---
  observationMinutes: z.coerce.number().int().min(1).default(5),
  baselineMinutes: z.coerce.number().int().min(1).default(60),
  // --- snapshots mode ---
  observationSamples: z.coerce.number().int().min(1).default(3),
  baselineSamples: z.coerce.number().int().min(1).default(12),
  // --- shared ---
  changePercent: z.coerce.number().min(0).default(50),
  direction: z.enum(['increase', 'decrease', 'either']).default('either'),
  /** Minimum baseline readings required before firing. */
  minBaselineSamples: z.coerce.number().int().min(1).default(3),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function windowKey(ruleId: string): string {
  return `sentinel:vcchange:${ruleId}`;
}

/** Parse `"{eventId}:{value}"` member format — same encoding as windowed-sum. */
function parseMemberValue(member: string): bigint | null {
  const colonIdx = member.lastIndexOf(':');
  if (colonIdx < 0) return null;
  try {
    return BigInt(member.slice(colonIdx + 1));
  } catch {
    return null;
  }
}

function parseMembers(members: string[]): bigint[] {
  const out: bigint[] = [];
  for (const m of members) {
    const v = parseMemberValue(m);
    if (v !== null) out.push(v);
  }
  return out;
}

function avgBigInt(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  return values.reduce((a, b) => a + b, 0n) / BigInt(values.length);
}

// ---------------------------------------------------------------------------
// Window retrieval — time mode
// ---------------------------------------------------------------------------

async function getWindowsTime(
  redis: EvalContext['redis'],
  key: string,
  now: number,
  observationMs: number,
  baselineMs: number,
): Promise<{ baselineMembers: string[]; obsMembers: string[] }> {
  await redis.zremrangebyscore(key, '-inf', now - baselineMs - 1);
  await redis.pexpire(key, baselineMs);
  const baselineMembers = await redis.zrangebyscore(key, now - baselineMs, now - observationMs);
  const obsMembers = await redis.zrangebyscore(key, now - observationMs, '+inf');
  return { baselineMembers, obsMembers };
}

// ---------------------------------------------------------------------------
// Window retrieval — snapshots mode
// ---------------------------------------------------------------------------

const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function getWindowsSnapshots(
  redis: EvalContext['redis'],
  key: string,
  observationSamples: number,
  baselineSamples: number,
): Promise<{ baselineMembers: string[]; obsMembers: string[] }> {
  await redis.pexpire(key, SNAPSHOT_TTL_MS);
  // Fetch all members sorted oldest → newest (ascending score = wall-clock time)
  const all = await redis.zrangebyscore(key, '-inf', '+inf');
  const obsMembers = all.slice(-observationSamples);
  const baselineEnd = all.length - observationSamples;
  const baselineStart = Math.max(0, baselineEnd - baselineSamples);
  const baselineMembers = all.slice(baselineStart, baselineEnd);
  return { baselineMembers, obsMembers };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const viewCallChangeEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.view_call_change',
  configSchema,
  uiSchema: [
    NETWORK_UI_FIELD,
    { ...CONTRACT_UI_FIELD, required: true, help: 'Contract whose view function is being tracked.' },
    { key: 'functionSignature', label: 'View function signature', type: 'text', required: true, placeholder: 'activeAttesterCount()', help: 'Read-only function whose return value is tracked for rate-of-change.' },
    { key: 'resultField', label: 'Result field', type: 'text', required: false, default: 'result', placeholder: 'result', help: 'Return value key to track. Defaults to the first return value.' },
    { key: 'windowMode', label: 'Window mode', type: 'select', required: false, options: [{ value: 'time', label: 'Time-based (minutes)' }, { value: 'snapshots', label: 'Snapshot count (readings)' }] },
    { key: 'observationMinutes', label: 'Observation window (min)', type: 'number', required: false, default: 5, min: 1, help: 'Recent window compared against the baseline. (time mode)' },
    { key: 'baselineMinutes', label: 'Baseline window (min)', type: 'number', required: false, default: 60, min: 1, help: 'Historical window used as the normal baseline. (time mode)' },
    { key: 'observationSamples', label: 'Observation readings', type: 'number', required: false, default: 3, min: 1, help: 'Number of most-recent poll readings to compare. (snapshots mode)' },
    { key: 'baselineSamples', label: 'Baseline readings', type: 'number', required: false, default: 12, min: 1, help: 'Number of prior poll readings used as the normal baseline. (snapshots mode)' },
    { key: 'changePercent', label: 'Change % to alert', type: 'number', required: true, default: 50, min: 0, help: 'Alert when the value changes by at least this percentage relative to the baseline.' },
    { key: 'direction', label: 'Direction', type: 'select', required: false, options: [{ value: 'either', label: 'Either direction' }, { value: 'increase', label: 'Increase only' }, { value: 'decrease', label: 'Decrease only' }] },
    { key: 'minBaselineSamples', label: 'Min baseline samples', type: 'number', required: false, default: 3, min: 1, help: 'Skip alert if baseline has fewer than this many valid readings.' },
  ],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule, redis } = ctx;

    if (event.eventType !== 'chain.view_call_result') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      contractAddress: string;
      functionName?: string;
      returnValues: Record<string, unknown>;
      blockNumber?: string;
    };

    if (payload.contractAddress.toLowerCase() !== config.contractAddress.toLowerCase()) return null;

    // Extract numeric return value — mirror view-call.ts field resolution
    const raw = payload.returnValues[config.resultField] ?? payload.returnValues['0'];
    if (raw === undefined || raw === null) return null;
    let currentValue: bigint;
    try {
      currentValue = BigInt(String(raw));
    } catch {
      return null; // Non-numeric return value
    }

    // Store reading: member = "{eventId}:{value}", score = wall-clock ms
    const key = windowKey(rule.id);
    const now = Date.now();
    const member = `${event.id}:${currentValue.toString()}`;
    await redis.zadd(key, now, member);

    // Retrieve observation and baseline windows
    let baselineMembers: string[];
    let obsMembers: string[];

    if (config.windowMode === 'snapshots') {
      ({ baselineMembers, obsMembers } = await getWindowsSnapshots(
        redis, key, config.observationSamples, config.baselineSamples,
      ));
    } else {
      const observationMs = config.observationMinutes * 60_000;
      const baselineMs = config.baselineMinutes * 60_000;
      ({ baselineMembers, obsMembers } = await getWindowsTime(
        redis, key, now, observationMs, baselineMs,
      ));
    }

    const baselineValues = parseMembers(baselineMembers);
    const obsValues = parseMembers(obsMembers);

    if (baselineValues.length < config.minBaselineSamples) return null;
    if (obsValues.length === 0) return null;

    const baselineAvg = avgBigInt(baselineValues);
    if (baselineAvg === 0n) return null; // Avoid division by zero

    const obsAvg = avgBigInt(obsValues);
    const percentChange = (Number(obsAvg - baselineAvg) / Number(baselineAvg)) * 100;

    const triggered =
      config.direction === 'increase' ? percentChange >= config.changePercent :
      config.direction === 'decrease' ? percentChange <= -config.changePercent :
      Math.abs(percentChange) >= config.changePercent;

    if (!triggered) return null;

    const fnName = payload.functionName ?? config.functionName ?? config.functionSignature;
    const sign = percentChange >= 0 ? '+' : '';
    const changeSummary = `${sign}${percentChange.toFixed(1)}%`;

    const windowContext = config.windowMode === 'snapshots'
      ? `last ${obsValues.length} vs prior ${baselineValues.length} readings`
      : `last ${config.observationMinutes}m vs ${config.baselineMinutes}m baseline`;

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `${fnName}: ${changeSummary} change on ${config.contractAddress}`,
      description: `${fnName} changed by ${changeSummary} (${windowContext}). Current avg: ${obsAvg.toString()}, baseline avg: ${baselineAvg.toString()}.`,
      triggerType: 'windowed',
      triggerData: {
        type: 'view-call-change',
        contractAddress: config.contractAddress,
        functionName: fnName,
        functionSignature: config.functionSignature,
        blockNumber: payload.blockNumber,
        windowMode: config.windowMode,
        // Value context
        currentAvg: obsAvg.toString(),
        baselineAvg: baselineAvg.toString(),
        percentChange,
        direction: config.direction,
        // Sample counts
        observationCount: obsValues.length,
        baselineCount: baselineValues.length,
        // Window config for display
        ...(config.windowMode === 'time'
          ? { observationMinutes: config.observationMinutes, baselineMinutes: config.baselineMinutes }
          : { observationSamples: config.observationSamples, baselineSamples: config.baselineSamples }),
      },
    };
  },
};
