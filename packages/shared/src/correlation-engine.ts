/**
 * CorrelationEngine — evaluates events against multi-step correlation rules.
 *
 * Handles: correlation rule loading, event-to-step matching, Redis state
 * management for in-flight correlation instances, cross-step field matching,
 * cooldown enforcement (Redis + DB fallback), and correlated alert emission.
 *
 * Returns CorrelatedAlertCandidates — the caller is responsible for DB writes
 * and job enqueueing. This keeps the engine testable.
 */
import { createHash } from 'node:crypto';
import { eq, and, asc, or, isNull, lt } from '@sentinel/db';
import { correlationRules } from '@sentinel/db/schema/correlation';
import type { Redis } from 'ioredis';
import type { Db } from '@sentinel/db';
import { getField, evaluateConditions } from './conditions.js';
import type { NormalizedEvent } from './rules.js';
import type {
  CorrelationRuleConfig,
  CorrelationRuleRow,
  CorrelationInstance,
  MatchedStep,
  CorrelatedAlertCandidate,
  EventFilter,
  CrossStepCondition,
  AggregationConfig,
  AbsenceConfig,
  AbsenceMatchCondition,
} from './correlation-types.js';
import { logger as rootLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPONENT = 'correlation-engine';

/** How long to cache loaded rules per org (ms). */
const RULE_CACHE_TTL_MS = 30_000;

/** Redis key prefix for correlation sequence instances. */
const SEQ_PREFIX = 'sentinel:corr:seq';

/** Redis key prefix for step index lookups. */
const IDX_PREFIX = 'sentinel:corr:idx';

/** Redis key prefix for cooldown locks. */
const COOLDOWN_PREFIX = 'sentinel:corr:cooldown';

/** Redis key prefix for aggregation counters. */
const AGG_PREFIX = 'sentinel:corr:agg';

/**
 * Redis key prefix for absence trigger instances.
 * Keys are written as `sentinel:corr:absence:<ruleId>:<keyHash>`.
 * The expiry handler scans with pattern `sentinel:corr:absence:*`.
 */
export const ABSENCE_PREFIX = 'sentinel:corr:absence';

/**
 * Redis sorted set that indexes absence keys by their expiresAt timestamp.
 * The expiry handler uses ZRANGEBYSCORE to efficiently find expired keys
 * instead of SCAN-ing the entire keyspace.
 */
export const ABSENCE_INDEX_KEY = 'sentinel:corr:absence:index';

/**
 * Redis key prefix for cross-process cache invalidation version counters.
 * The API increments `sentinel:corr:version:<orgId>` on every CRUD operation;
 * the worker checks this before using cached rules, so stale cache entries
 * are detected and refreshed immediately rather than waiting for the full
 * 30-second TTL.
 */
export const CORR_VERSION_PREFIX = 'sentinel:corr:version';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a string actor identifier from an event payload.
 *
 * GitHub events carry `sender` as `{ login: string }`, while other sources
 * may provide a plain string `actor` or `sender`. This helper normalises
 * both shapes so that MatchedStep.actor is always a plain string (or null).
 */
function extractActorString(payload: Record<string, unknown>): string | null {
  for (const key of ['actor', 'sender'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (value != null && typeof value === 'object' && 'login' in (value as Record<string, unknown>)) {
      const login = (value as Record<string, string>).login;
      if (typeof login === 'string' && login.length > 0) return login;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

/**
 * Atomic aggregation check for simple-count (INCR) mode.
 *
 * Atomically increments the counter, refreshes the window TTL, and — if the
 * threshold is reached — deletes the key in the same script so no second
 * worker can observe count >= threshold before the reset.
 *
 * KEYS[1]  = counter key
 * ARGV[1]  = threshold (integer)
 * ARGV[2]  = window TTL in milliseconds
 *
 * Returns: { count, fired }
 *   As a two-element array: [count, 1] if threshold reached (key deleted),
 *   [count, 0] otherwise.
 */
const AGG_INCR_LUA = `
local count = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if count >= tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return {count, 1}
end
return {count, 0}
`;

/**
 * Atomic aggregation check for distinct-count (SADD) mode.
 *
 * Atomically adds the value to the set, refreshes the window TTL, and — if
 * the distinct-value count reaches threshold — deletes the set so no second
 * worker can also observe count >= threshold.
 *
 * KEYS[1]  = set key
 * ARGV[1]  = new member to add
 * ARGV[2]  = threshold (integer)
 * ARGV[3]  = window TTL in milliseconds
 *
 * Returns: two-element array [count, fired]
 *   [count, 1] if threshold reached (set deleted), [count, 0] otherwise.
 */
const AGG_SADD_LUA = `
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
local count = redis.call('SCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {count, 1}
end
return {count, 0}
`;

/**
 * Atomic compare-and-swap for sequence instance advancement.
 *
 * Prevents lost updates when two workers process events for the same
 * correlation key concurrently: both load the instance, advance
 * independently, and the last redis.set() wins. This script only writes
 * if the current `currentStepIndex` in Redis matches the expected value,
 * ensuring exactly-once step advancement.
 *
 * KEYS[1]  = sequence instance key
 * ARGV[1]  = expected currentStepIndex (the value loaded before advancing)
 * ARGV[2]  = new serialized instance JSON
 * ARGV[3]  = TTL in milliseconds
 *
 * Returns:
 *   1  — CAS succeeded, key updated
 *   0  — CAS failed, stale (currentStepIndex mismatch)
 *  -1  — key no longer exists (expired or deleted)
 */
const SEQ_ADVANCE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return -1
end
local ok, instance = pcall(cjson.decode, raw)
if not ok then
  return -1
end
local expected = tonumber(ARGV[1])
if instance['currentStepIndex'] ~= expected then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return 1
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrelationEngineConfig {
  redis: Redis;
  db: Db;
  logger?: Logger;
}

export interface CorrelationEvaluationResult {
  /** Correlated alert candidates produced by completed sequences. */
  candidates: CorrelatedAlertCandidate[];
  /** Correlation rule IDs that were advanced (step matched but sequence not yet complete). */
  advancedRuleIds: Set<string>;
  /** Correlation rule IDs where a new instance was started. */
  startedRuleIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Rule cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  rules: CorrelationRuleRow[];
  fetchedAt: number;
  /** Redis version counter at the time rules were fetched. */
  version: number;
}

// ---------------------------------------------------------------------------
// Module-level rule cache (shared across all CorrelationEngine instances in the
// same process).
//
// Previously this was a class instance variable (`private readonly ruleCache`),
// which meant each worker spawned with `concurrency: N` maintained its own
// independent Map.  A CRUD-triggered `invalidateCache(orgId)` only cleared the
// cache in whichever instance handled that HTTP request; the other N-1 workers
// continued serving stale rules for up to RULE_CACHE_TTL_MS (30 s).
//
// Moving the Map to module scope ensures all instances share one cache and one
// invalidation path, which is safe because Node.js modules are singletons
// within a process (CommonJS module registry / ESM module graph both guarantee
// this).
// ---------------------------------------------------------------------------

const moduleRuleCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// CorrelationEngine
// ---------------------------------------------------------------------------

export class CorrelationEngine {
  private readonly redis: Redis;
  private readonly db: Db;
  private readonly log: Logger;

  constructor(config: CorrelationEngineConfig) {
    this.redis = config.redis;
    this.db = config.db;
    this.log = config.logger ?? rootLogger.child({ component: COMPONENT });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Evaluate an event against all active correlation rules for its org.
   */
  async evaluate(event: NormalizedEvent): Promise<CorrelationEvaluationResult> {
    const candidates: CorrelatedAlertCandidate[] = [];
    const advancedRuleIds = new Set<string>();
    const startedRuleIds = new Set<string>();

    let activeRules: CorrelationRuleRow[];
    try {
      activeRules = await this.loadRules(event.orgId);
    } catch (err) {
      this.log.error({ err, orgId: event.orgId }, 'Failed to load correlation rules');
      return { candidates, advancedRuleIds, startedRuleIds };
    }

    for (const rule of activeRules) {
      try {
        const result = await this.evaluateRule(rule, event);
        if (result.candidate) {
          candidates.push(result.candidate);
        }
        if (result.advanced) {
          advancedRuleIds.add(rule.id);
        }
        if (result.started) {
          startedRuleIds.add(rule.id);
        }
      } catch (err) {
        this.log.error({ err, ruleId: rule.id }, 'Error evaluating correlation rule');
      }
    }

    return { candidates, advancedRuleIds, startedRuleIds };
  }

  // -------------------------------------------------------------------------
  // Rule loading (cached)
  // -------------------------------------------------------------------------

  /**
   * Load active correlation rules for an org, with a short in-memory cache.
   *
   * Uses the module-level `moduleRuleCache` so all CorrelationEngine instances
   * in the same process share one cache — see the comment above the Map
   * declaration for the rationale.
   */
  async loadRules(orgId: string): Promise<CorrelationRuleRow[]> {
    const cached = moduleRuleCache.get(orgId);
    if (cached && Date.now() - cached.fetchedAt < RULE_CACHE_TTL_MS) {
      // Check the cross-process version counter. If the API bumped it since
      // we last fetched, our cached rules are stale and must be refreshed.
      try {
        const versionStr = await this.redis.get(`${CORR_VERSION_PREFIX}:${orgId}`);
        const currentVersion = versionStr ? parseInt(versionStr, 10) : 0;
        if (currentVersion === cached.version) {
          return cached.rules;
        }
        this.log.debug({ orgId, cachedVersion: cached.version, currentVersion }, 'Correlation rule cache version mismatch — refreshing');
      } catch {
        // If Redis is unreachable, fall through to a DB refresh rather than
        // serving potentially stale data.
      }
    }

    // Read the current version counter BEFORE querying the DB so that a
    // concurrent API write that lands between our GET and SELECT is not
    // missed — the next loadRules call will see the bumped version.
    let version = 0;
    try {
      const versionStr = await this.redis.get(`${CORR_VERSION_PREFIX}:${orgId}`);
      version = versionStr ? parseInt(versionStr, 10) : 0;
    } catch {
      // If Redis is down the version stays 0; the cache will always be
      // treated as stale (safe default).
    }

    const rows = await this.db
      .select()
      .from(correlationRules)
      .where(
        and(
          eq(correlationRules.orgId, orgId),
          eq(correlationRules.status, 'active'),
        ),
      )
      .orderBy(asc(correlationRules.name));

    moduleRuleCache.set(orgId, { rules: rows as CorrelationRuleRow[], fetchedAt: Date.now(), version });
    return rows as CorrelationRuleRow[];
  }

  /**
   * Invalidate the rule cache for an org. Call after rule CRUD.
   *
   * Because the cache is module-level, this invalidation is visible to every
   * CorrelationEngine instance running in the same process — regardless of
   * which worker handled the CRUD request.
   */
  invalidateCache(orgId: string): void {
    moduleRuleCache.delete(orgId);
  }

  // -------------------------------------------------------------------------
  // Single-rule evaluation
  // -------------------------------------------------------------------------

  private async evaluateRule(
    rule: CorrelationRuleRow,
    event: NormalizedEvent,
  ): Promise<{ candidate: CorrelatedAlertCandidate | null; advanced: boolean; started: boolean }> {
    const config = rule.config as CorrelationRuleConfig;

    switch (config.type) {
      case 'aggregation':
        return this.evaluateAggregation(rule, config, event);
      case 'absence':
        return this.evaluateAbsence(rule, config, event);
      case 'sequence':
        break; // fall through to existing sequence logic below
      default:
        return { candidate: null, advanced: false, started: false };
    }

    const steps = config.steps;
    if (!steps || steps.length === 0) {
      return { candidate: null, advanced: false, started: false };
    }

    // Find which step indices this event could match
    const matchingStepIndices = this.findMatchingSteps(config, event);
    if (matchingStepIndices.length === 0) {
      return { candidate: null, advanced: false, started: false };
    }

    // Compute correlation key hash from event payload
    const keyResult = this.computeCorrelationKey(config, event);
    if (!keyResult) {
      return { candidate: null, advanced: false, started: false };
    }
    const { hash: keyHash, values: keyValues } = keyResult;

    let candidate: CorrelatedAlertCandidate | null = null;
    let advanced = false;
    let started = false;

    // Try to advance an existing instance first
    const existing = await this.loadInstance(rule.id, keyHash);

    if (existing) {
      const priorStepIndex = existing.currentStepIndex;
      const nextStepIndex = priorStepIndex + 1;

      // Check if event matches the next expected step
      if (matchingStepIndices.includes(nextStepIndex)) {
        const step = steps[nextStepIndex];

        // Check per-step time constraint
        if (step.withinMinutes != null) {
          const prevTimestamp = existing.matchedSteps[existing.matchedSteps.length - 1].timestamp;
          const elapsed = (event.occurredAt.getTime() - prevTimestamp) / 60_000;
          if (elapsed > step.withinMinutes) {
            // Timed out between steps — remove stale instance
            await this.deleteInstance(rule.id, keyHash, nextStepIndex);
            // Fall through to check if event can start a new sequence
          } else if (this.checkCrossStepConditions(step.matchConditions, event, existing)) {
            // Advance the instance
            const matchedStep = this.buildMatchedStep(step.name, event);
            existing.matchedSteps.push(matchedStep);
            existing.currentStepIndex = nextStepIndex;

            if (nextStepIndex === steps.length - 1) {
              // Sequence complete — check cooldown, emit candidate
              const passed = await this.checkCooldown(rule);
              if (passed) {
                candidate = this.buildCandidate(rule, config, existing);
              }
              // Clean up completed instance
              await this.deleteInstance(rule.id, keyHash, nextStepIndex);
            } else {
              // Save updated instance with CAS — reject if another worker already advanced
              const saved = await this.saveInstance(rule.id, keyHash, existing, config.windowMinutes, priorStepIndex);
              if (saved) advanced = true;
            }
          }
          // If cross-step conditions fail, we don't advance — fall through
        } else if (this.checkCrossStepConditions(step.matchConditions, event, existing)) {
          // No per-step time constraint — advance
          const matchedStep = this.buildMatchedStep(step.name, event);
          existing.matchedSteps.push(matchedStep);
          existing.currentStepIndex = nextStepIndex;

          if (nextStepIndex === steps.length - 1) {
            const passed = await this.checkCooldown(rule);
            if (passed) {
              candidate = this.buildCandidate(rule, config, existing);
            }
            await this.deleteInstance(rule.id, keyHash, nextStepIndex);
          } else {
            // Save updated instance with CAS — reject if another worker already advanced
            const saved = await this.saveInstance(rule.id, keyHash, existing, config.windowMinutes, priorStepIndex);
            if (saved) advanced = true;
          }
        }
      }

      // Check overall window expiration.
      // IMPORTANT: only delete if we did NOT just advance the instance — a
      // saveInstance call above may have written a fresh copy with an updated
      // currentStepIndex; deleting here would destroy that freshly saved state.
      // We detect "just advanced" by checking the advanced flag which was set
      // inside the advance branches above.
      // Use priorStepIndex (captured before local mutation) so we don't
      // accidentally delete index keys belonging to the freshly-saved step
      // when existing.currentStepIndex was bumped locally but CAS failed.
      if (!advanced && Date.now() > existing.expiresAt) {
        await this.deleteInstance(rule.id, keyHash, priorStepIndex + 1);
      }
    }

    // If event matches step 0, start a new instance (even if we just advanced another)
    if (!started && matchingStepIndices.includes(0)) {
      // Only start if no existing instance or existing was just cleaned up
      const currentInstance = await this.loadInstance(rule.id, keyHash);
      if (!currentInstance) {
        const now = Date.now();
        const instance: CorrelationInstance = {
          ruleId: rule.id,
          orgId: event.orgId,
          correlationKeyHash: keyHash,
          correlationKeyValues: keyValues,
          currentStepIndex: 0,
          startedAt: now,
          expiresAt: now + config.windowMinutes * 60_000,
          matchedSteps: [this.buildMatchedStep(steps[0].name, event)],
        };

        // Edge case: single-step sequence (unusual but handle gracefully)
        if (steps.length === 1) {
          const passed = await this.checkCooldown(rule);
          if (passed) {
            candidate = this.buildCandidate(rule, config, instance);
          }
        } else {
          const saved = await this.saveInstance(rule.id, keyHash, instance, config.windowMinutes);
          if (saved) started = true;
        }
      }
    }

    return { candidate, advanced, started };
  }

  // -------------------------------------------------------------------------
  // Aggregation evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate an event against an aggregation rule.
   * Counts events (or distinct field values) per correlation key within a window.
   * Fires alert when the threshold is reached.
   */
  private async evaluateAggregation(
    rule: CorrelationRuleRow,
    config: CorrelationRuleConfig,
    event: NormalizedEvent,
  ): Promise<{ candidate: CorrelatedAlertCandidate | null; advanced: boolean; started: boolean }> {
    const agg = config.aggregation;
    if (!agg) return { candidate: null, advanced: false, started: false };

    // Check if event matches the aggregation filter
    if (!this.matchesEventFilter(agg.eventFilter, event)) {
      return { candidate: null, advanced: false, started: false };
    }

    // Compute correlation key
    const keyResult = this.computeCorrelationKey(config, event);
    if (!keyResult) return { candidate: null, advanced: false, started: false };
    const { hash: keyHash, values: keyValues } = keyResult;

    // Build the Redis key — include groupByField value if present.
    //
    // The raw field value is encoded with encodeURIComponent before being
    // embedded in the key.  Without encoding, a crafted event payload whose
    // group field contains `:` characters (e.g. "foo:bar") would embed those
    // colons verbatim, collapsing the structural delimiter that separates the
    // key segments (`AGG_PREFIX`, `set`/`cnt`, `ruleId`, `keyHash`, `g`,
    // `groupVal`).  This can cause keys from different group values — or
    // theoretically from different rules sharing a common prefix — to alias
    // the same Redis key, producing incorrect counter/set state.
    //
    // encodeURIComponent converts `:` → `%3A` (and other special chars
    // similarly), keeping each segment unambiguous while remaining
    // human-readable for debugging.
    let groupSuffix = '';
    if (agg.groupByField) {
      const groupVal = getField(event.payload, agg.groupByField);
      const encodedGroupVal = encodeURIComponent(String(groupVal ?? '_'));
      groupSuffix = `:g:${encodedGroupVal}`;
    }

    const windowMs = config.windowMinutes * 60_000;

    if (agg.countField) {
      // Count distinct mode — use a Redis set to track unique values.
      // AGG_SADD_LUA atomically SADDs, refreshes TTL, checks cardinality,
      // and DELetes the set if threshold is reached — all in one round-trip,
      // preventing two concurrent workers from both observing count >= threshold.
      const setKey = `${AGG_PREFIX}:set:${rule.id}:${keyHash}${groupSuffix}`;
      const distinctValue = getField(event.payload, agg.countField);
      if (distinctValue == null) return { candidate: null, advanced: false, started: false };

      const [currentCount, fired] = await this.redis.eval(
        AGG_SADD_LUA,
        1,
        setKey,
        String(distinctValue),
        String(agg.threshold),
        String(windowMs),
      ) as [number, number];

      if (fired === 1) {
        const passed = await this.checkCooldown(rule);
        if (passed) {
          const candidate = this.buildAggregationCandidate(rule, config, keyValues, currentCount, agg);
          return { candidate, advanced: false, started: false };
        }
      }
    } else {
      // Simple count mode — use Redis INCR.
      // AGG_INCR_LUA atomically INCRs, refreshes TTL, checks threshold,
      // and DELetes the counter if threshold is reached — preventing two
      // concurrent workers from both seeing count >= threshold.
      const counterKey = `${AGG_PREFIX}:cnt:${rule.id}:${keyHash}${groupSuffix}`;

      const [currentCount, fired] = await this.redis.eval(
        AGG_INCR_LUA,
        1,
        counterKey,
        String(agg.threshold),
        String(windowMs),
      ) as [number, number];

      if (fired === 1) {
        const passed = await this.checkCooldown(rule);
        if (passed) {
          const candidate = this.buildAggregationCandidate(rule, config, keyValues, currentCount, agg);
          return { candidate, advanced: false, started: false };
        }
      }
    }

    // `started` tracks whether this is the first event to contribute to the
    // aggregation window. Only return true on the very first INCR (count == 1)
    // or when the set transitions from empty to non-empty (SADD returned 1).
    // We don't have that information here without extra round-trips, so we
    // return false — this field is informational only and was previously
    // always true (incorrect). Returning false is the conservative correct value.
    return { candidate: null, advanced: false, started: false };
  }

  /**
   * Build an alert candidate for a completed aggregation threshold.
   */
  private buildAggregationCandidate(
    rule: CorrelationRuleRow,
    config: CorrelationRuleConfig,
    keyValues: Record<string, string>,
    count: number,
    agg: AggregationConfig,
  ): CorrelatedAlertCandidate {
    const countDesc = agg.countField
      ? `${count} distinct values of ${agg.countField}`
      : `${count} events`;
    const groupDesc = agg.groupByField ? ` grouped by ${agg.groupByField}` : '';

    return {
      orgId: rule.orgId,
      correlationRuleId: rule.id,
      severity: rule.severity,
      title: `Aggregation: ${rule.name}`,
      description: `Threshold reached: ${countDesc}${groupDesc} within ${config.windowMinutes} min. `
        + `Correlation key: ${JSON.stringify(keyValues)}.`,
      triggerType: 'correlated',
      triggerData: {
        correlationType: 'aggregation',
        correlationKey: keyValues,
        windowMinutes: config.windowMinutes,
        matchedSteps: [],
        sameActor: false,
        actors: [],
        timeSpanMinutes: config.windowMinutes,
        modules: agg.eventFilter.moduleId ? [agg.eventFilter.moduleId] : [],
      },
    };
  }

  // -------------------------------------------------------------------------
  // Absence evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate an event against an absence rule.
   *
   * Trigger event: starts a timer in Redis (the expiry handler creates
   * the alert if the expected event never arrives).
   *
   * Expected event: cancels the timer if it matches the trigger instance
   * (using matchConditions to link fields between trigger and expected).
   */
  private async evaluateAbsence(
    rule: CorrelationRuleRow,
    config: CorrelationRuleConfig,
    event: NormalizedEvent,
  ): Promise<{ candidate: CorrelatedAlertCandidate | null; advanced: boolean; started: boolean }> {
    const absence = config.absence;
    if (!absence) return { candidate: null, advanced: false, started: false };

    // Compute correlation key
    const keyResult = this.computeCorrelationKey(config, event);
    if (!keyResult) return { candidate: null, advanced: false, started: false };
    const { hash: keyHash, values: keyValues } = keyResult;

    const redisKey = `${ABSENCE_PREFIX}:${rule.id}:${keyHash}`;
    const isTrigger = this.matchesEventFilter(absence.trigger.eventFilter, event);
    const isExpected = this.matchesEventFilter(absence.expected.eventFilter, event);

    // Handle trigger event — start the absence timer
    if (isTrigger) {
      const graceMs = absence.graceMinutes * 60_000;
      const now = Date.now();
      const instance: CorrelationInstance = {
        ruleId: rule.id,
        orgId: event.orgId,
        correlationKeyHash: keyHash,
        correlationKeyValues: keyValues,
        currentStepIndex: 0,
        startedAt: now,
        expiresAt: now + graceMs,
        matchedSteps: [this.buildMatchedStep('trigger', event)],
      };

      // Store with TTL slightly longer than grace period so the expiry handler can find it
      // The expiry handler checks expiresAt, not the Redis TTL directly
      const ttlMs = graceMs + 60_000; // grace + 1 min buffer

      // Atomic SET NX — prevents TOCTOU race where two workers both see no
      // existing trigger and both create one, losing the first trigger event.
      const res = await this.redis.set(redisKey, JSON.stringify(instance), 'PX', ttlMs, 'NX');
      if (res !== null) {
        // Index the absence key by expiresAt so the expiry handler can use
        // ZRANGEBYSCORE instead of SCAN to find expired keys efficiently.
        await this.redis.zadd(ABSENCE_INDEX_KEY, instance.expiresAt, redisKey);

        return { candidate: null, advanced: false, started: true };
      }
      // NX failed — another worker already created the trigger, skip
    }

    // Handle expected event — cancel the timer if matchConditions pass
    if (isExpected) {
      const raw = await this.redis.get(redisKey);
      if (raw) {
        // Guard against corrupted or attacker-injected Redis data.
        // Without try/catch a JSON.parse failure throws synchronously inside
        // evaluateAbsence, propagating up through evaluateRule's catch block
        // and silently suppressing evaluation of the entire rule for this event.
        let instance: CorrelationInstance;
        try {
          instance = JSON.parse(raw) as CorrelationInstance;
        } catch (parseErr) {
          this.log.error(
            { err: parseErr, ruleId: rule.id, keyHash },
            'Corrupted absence instance in Redis — skipping entry',
          );
          // Delete the corrupted entry so it does not permanently block the rule.
          await this.redis.del(redisKey);
          await this.redis.zrem(ABSENCE_INDEX_KEY, redisKey);
          return { candidate: null, advanced: false, started: false };
        }

        // Check absence matchConditions — compare expected event fields against trigger event fields
        const matchConditions = absence.expected.matchConditions ?? [];
        if (this.checkAbsenceMatchConditions(matchConditions, event, instance)) {
          // Expected event arrived and matches — cancel the absence timer
          await this.redis.del(redisKey);
          await this.redis.zrem(ABSENCE_INDEX_KEY, redisKey);
          this.log.debug({ ruleId: rule.id, keyHash }, 'Absence timer cancelled — expected event received');
          return { candidate: null, advanced: true, started: false };
        }
      }
    }

    return { candidate: null, advanced: false, started: false };
  }

  /**
   * Check absence match conditions. These compare fields in the expected event
   * against fields captured from the trigger event.
   */
  private checkAbsenceMatchConditions(
    conditions: AbsenceMatchCondition[],
    expectedEvent: NormalizedEvent,
    triggerInstance: CorrelationInstance,
  ): boolean {
    if (conditions.length === 0) return true;

    // The trigger event's fields are stored in matchedSteps[0].fields
    const triggerFields = triggerInstance.matchedSteps[0]?.fields;
    if (!triggerFields) return conditions.length === 0;

    return conditions.every((cond) => {
      const expectedValue = getField(expectedEvent.payload, cond.field);
      if (expectedValue === undefined) return false;

      const triggerValue = getField(triggerFields as Record<string, unknown>, cond.triggerField);

      switch (cond.operator) {
        case '==': return String(expectedValue) === String(triggerValue);
        case '!=': return String(expectedValue) !== String(triggerValue);
        default:   return false;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Event matching
  // -------------------------------------------------------------------------

  /**
   * Return indices of steps whose eventFilter matches the given event.
   */
  private findMatchingSteps(config: CorrelationRuleConfig, event: NormalizedEvent): number[] {
    const steps = config.steps;
    if (!steps) return [];

    const matched: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (this.matchesEventFilter(steps[i].eventFilter, event)) {
        matched.push(i);
      }
    }
    return matched;
  }

  /**
   * Check if an event matches a step's event filter.
   * Uses evaluateConditions from conditions.ts for the conditions array.
   */
  private matchesEventFilter(filter: EventFilter, event: NormalizedEvent): boolean {
    // Module filter
    if (filter.moduleId != null && filter.moduleId !== event.moduleId) {
      return false;
    }

    // Event type filter — supports single string or array
    if (filter.eventType != null) {
      const allowed = Array.isArray(filter.eventType) ? filter.eventType : [filter.eventType];
      if (!allowed.includes(event.eventType)) {
        return false;
      }
    }

    // Conditions — delegate to shared evaluateConditions (AND logic)
    if (filter.conditions && filter.conditions.length > 0) {
      if (!evaluateConditions(event.payload, filter.conditions)) {
        return false;
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Correlation key
  // -------------------------------------------------------------------------

  /**
   * Compute a correlation key hash from event payload fields.
   * Returns null if any required key field is missing from the event.
   */
  private computeCorrelationKey(
    config: CorrelationRuleConfig,
    event: NormalizedEvent,
  ): { hash: string; values: Record<string, string> } | null {
    const keyFields = config.correlationKey;
    if (!keyFields || keyFields.length === 0) {
      // No correlation key configured (schema requires min(1) so this should
      // not occur in practice, but guard defensively).
      // Returning null causes the rule to be skipped for this event, which is
      // safer than collapsing all org events into a single shared bucket and
      // producing false-positive aggregations/sequences across unrelated events.
      return null;
    }

    const values: Record<string, string> = {};
    const parts: string[] = [];

    for (const keyDef of keyFields) {
      const raw = getField(event.payload, keyDef.field);
      if (raw == null) {
        // Required correlation key field is missing — skip this rule for this event
        return null;
      }
      const strVal = String(raw);
      const alias = keyDef.alias ?? keyDef.field;
      values[alias] = strVal;
      parts.push(`${alias}=${strVal}`);
    }

    const hash = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
    return { hash, values };
  }

  // -------------------------------------------------------------------------
  // Cross-step match conditions
  // -------------------------------------------------------------------------

  /**
   * Evaluate cross-step match conditions. These compare fields in the current
   * event against fields captured in previous steps.
   *
   * Returns true if all conditions pass, or if there are no conditions.
   */
  private checkCrossStepConditions(
    conditions: CrossStepCondition[] | undefined,
    event: NormalizedEvent,
    instance: CorrelationInstance,
  ): boolean {
    if (!conditions || conditions.length === 0) return true;

    return conditions.every((cond) => {
      const currentValue = getField(event.payload, cond.field);
      if (currentValue === undefined) return false;

      // Resolve the ref — format is "stepName.fieldPath" or "steps[index].fieldPath"
      const refValue = this.resolveStepRef(cond.ref, instance);

      switch (cond.operator) {
        case '==': return String(currentValue) === String(refValue);
        case '!=': return String(currentValue) !== String(refValue);
        default:   return false;
      }
    });
  }

  /**
   * Resolve a cross-step reference like "step_name.field.path" to the actual
   * captured value from a previous step's fields.
   */
  private resolveStepRef(ref: string, instance: CorrelationInstance): unknown {
    const dotIndex = ref.indexOf('.');
    if (dotIndex === -1) return undefined;

    const stepName = ref.slice(0, dotIndex);
    const fieldPath = ref.slice(dotIndex + 1);

    const step = instance.matchedSteps.find((s) => s.stepName === stepName);
    if (!step) return undefined;

    return getField(step.fields as Record<string, unknown>, fieldPath);
  }

  // -------------------------------------------------------------------------
  // Redis instance management
  // -------------------------------------------------------------------------

  /**
   * Load a correlation instance from Redis.
   */
  private async loadInstance(
    ruleId: string,
    keyHash: string,
  ): Promise<CorrelationInstance | null> {
    const redisKey = `${SEQ_PREFIX}:${ruleId}:${keyHash}`;
    try {
      const raw = await this.redis.get(redisKey);
      if (!raw) return null;

      const instance = JSON.parse(raw) as CorrelationInstance;

      // Check if the instance has expired
      if (Date.now() > instance.expiresAt) {
        await this.deleteInstance(ruleId, keyHash, instance.currentStepIndex + 1);
        return null;
      }

      return instance;
    } catch (err) {
      this.log.error({ err, redisKey }, 'Failed to load correlation instance');
      return null;
    }
  }

  /**
   * Save a correlation instance to Redis with TTL anchored to the original
   * window start time.
   *
   * Previously this used `windowMinutes * 60_000` as the TTL on every call,
   * which reset the full window duration each time a step was advanced.  A
   * 29-minute-old instance advancing to the next step would therefore be kept
   * alive for another full window, allowing multi-step sequences to be matched
   * far beyond the intended time boundary.
   *
   * The fix computes TTL as `instance.expiresAt - Date.now()` — i.e. the time
   * remaining until the original window expires — so no step advance can extend
   * the lifetime of the instance beyond its original deadline.
   *
   * The `windowMinutes` parameter is retained in the signature so call-sites
   * do not need updating; it is no longer used for the TTL calculation but is
   * kept for potential future use (e.g. logging, metrics).
   */
  /**
   * Save a correlation instance to Redis with atomic compare-and-swap.
   *
   * @param expectedStepIndex The currentStepIndex value observed when the
   *   instance was loaded. If another worker has already advanced the
   *   instance past this step, the write is rejected (returns false).
   *   Pass `null` for new instances (step 0) where there is no prior
   *   value to compare against — these use a plain SET.
   * @returns `true` if the write succeeded, `false` if a concurrent
   *   worker already advanced the instance (CAS mismatch).
   */
  private async saveInstance(
    ruleId: string,
    keyHash: string,
    instance: CorrelationInstance,
    _windowMinutes: number,
    expectedStepIndex: number | null = null,
  ): Promise<boolean> {
    const redisKey = `${SEQ_PREFIX}:${ruleId}:${keyHash}`;
    // Anchor TTL to the original window expiry, not a fresh full-window duration.
    const ttlMs = Math.max(1, instance.expiresAt - Date.now());

    try {
      const serialized = JSON.stringify(instance);

      if (expectedStepIndex !== null) {
        // Atomic CAS — only write if the instance in Redis still has the
        // expected currentStepIndex. This prevents lost updates when two
        // workers load the same instance concurrently.
        const result = await this.redis.eval(
          SEQ_ADVANCE_LUA,
          1,
          redisKey,
          String(expectedStepIndex),
          serialized,
          String(ttlMs),
        ) as number;

        if (result !== 1) {
          this.log.warn(
            { redisKey, expectedStepIndex, result },
            'CAS failed on sequence instance save — another worker advanced it',
          );
          return false;
        }
      } else {
        // New instance (step 0) — use NX to prevent TOCTOU race where two
        // workers both see no existing instance and both create one, with the
        // second write silently overwriting the first and losing its matched step.
        const res = await this.redis.set(redisKey, serialized, 'PX', ttlMs, 'NX');
        if (res === null) {
          this.log.warn(
            { redisKey },
            'NX failed on new sequence instance — another worker already created it',
          );
          return false;
        }
      }

      // Update step index for quick lookups
      const idxKey = `${IDX_PREFIX}:${ruleId}:${instance.currentStepIndex}:${keyHash}`;
      await this.redis.set(idxKey, '1', 'PX', ttlMs);
      return true;
    } catch (err) {
      this.log.error({ err, redisKey }, 'Failed to save correlation instance');
      return false;
    }
  }

  /**
   * Delete a correlation instance and its step index from Redis.
   */
  private async deleteInstance(
    ruleId: string,
    keyHash: string,
    currentNextStep: number,
  ): Promise<void> {
    const redisKey = `${SEQ_PREFIX}:${ruleId}:${keyHash}`;
    try {
      await this.redis.del(redisKey);

      // Clean up step index entries for all previous steps
      const pipeline = this.redis.pipeline();
      for (let i = 0; i < currentNextStep; i++) {
        pipeline.del(`${IDX_PREFIX}:${ruleId}:${i}:${keyHash}`);
      }
      await pipeline.exec();
    } catch (err) {
      this.log.error({ err, redisKey }, 'Failed to delete correlation instance');
    }
  }

  // -------------------------------------------------------------------------
  // Cooldown
  // -------------------------------------------------------------------------

  /**
   * Attempt to acquire cooldown lock for a correlation rule.
   * Returns true if the rule is allowed to fire (cooldown period has elapsed).
   * Uses Redis SET NX PX with DB-based fallback — same pattern as RuleEngine.
   */
  private async checkCooldown(rule: CorrelationRuleRow): Promise<boolean> {
    if (!rule.cooldownMinutes || rule.cooldownMinutes <= 0) return true;

    const cooldownMs = rule.cooldownMinutes * 60_000;
    const redisKey = `${COOLDOWN_PREFIX}:${rule.id}`;

    try {
      const acquired = await this.redis.set(redisKey, '1', 'PX', cooldownMs, 'NX');
      return !!acquired;
    } catch (redisErr) {
      // Redis unavailable — fall back to atomic DB-based cooldown
      this.log.warn({ err: redisErr, ruleId: rule.id }, 'Redis unavailable for cooldown, falling back to DB');
      try {
        const cooldownThreshold = new Date(Date.now() - cooldownMs);
        const [acquired] = await this.db
          .update(correlationRules)
          .set({ lastTriggeredAt: new Date() })
          .where(
            and(
              eq(correlationRules.id, rule.id),
              or(
                isNull(correlationRules.lastTriggeredAt),
                lt(correlationRules.lastTriggeredAt, cooldownThreshold),
              ),
            ),
          )
          .returning({ id: correlationRules.id });
        return !!acquired;
      } catch (dbErr) {
        this.log.error({ err: dbErr, ruleId: rule.id }, 'DB cooldown fallback failed');
        // Fail open — allow the alert rather than silently dropping it
        return true;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Builder helpers
  // -------------------------------------------------------------------------

  /**
   * Build a MatchedStep record from an event.
   */
  private buildMatchedStep(stepName: string, event: NormalizedEvent): MatchedStep {
    return {
      stepName,
      eventId: event.id,
      eventType: event.eventType,
      timestamp: event.occurredAt.getTime(),
      actor: extractActorString(event.payload) ?? null,
      fields: { ...event.payload },
    };
  }

  /**
   * Build a CorrelatedAlertCandidate from a completed correlation instance.
   */
  private buildCandidate(
    rule: CorrelationRuleRow,
    config: CorrelationRuleConfig,
    instance: CorrelationInstance,
  ): CorrelatedAlertCandidate {
    const actors = [
      ...new Set(
        instance.matchedSteps
          .map((s) => s.actor)
          .filter((a): a is string => a != null),
      ),
    ];
    const sameActor = actors.length <= 1;
    const modules = [
      ...new Set(
        instance.matchedSteps
          .map((s) => (s.fields.moduleId as string) ?? null)
          .filter((m): m is string => m != null),
      ),
    ];

    const firstTs = instance.matchedSteps[0].timestamp;
    const lastTs = instance.matchedSteps[instance.matchedSteps.length - 1].timestamp;
    const timeSpanMinutes = Math.round((lastTs - firstTs) / 60_000 * 100) / 100;

    const stepSummary = instance.matchedSteps
      .map((s) => `${s.stepName} (${s.eventType})`)
      .join(' -> ');

    return {
      orgId: instance.orgId,
      correlationRuleId: rule.id,
      severity: rule.severity,
      title: `Correlated: ${rule.name}`,
      description: `Sequence completed: ${stepSummary}. `
        + `${sameActor ? `Actor: ${actors[0] ?? 'unknown'}` : `Actors: ${actors.join(', ')}`}. `
        + `Time span: ${timeSpanMinutes} min.`,
      triggerType: 'correlated',
      triggerData: {
        correlationType: config.type,
        correlationKey: instance.correlationKeyValues,
        windowMinutes: config.windowMinutes,
        matchedSteps: instance.matchedSteps,
        sameActor,
        actors,
        timeSpanMinutes,
        modules,
      },
    };
  }
}
