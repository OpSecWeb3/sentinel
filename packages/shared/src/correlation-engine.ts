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
}

// ---------------------------------------------------------------------------
// CorrelationEngine
// ---------------------------------------------------------------------------

export class CorrelationEngine {
  private readonly redis: Redis;
  private readonly db: Db;
  private readonly log: Logger;

  /** In-memory rule cache keyed by orgId. Short TTL to avoid stale configs. */
  private readonly ruleCache = new Map<string, CacheEntry>();

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
   */
  async loadRules(orgId: string): Promise<CorrelationRuleRow[]> {
    const cached = this.ruleCache.get(orgId);
    if (cached && Date.now() - cached.fetchedAt < RULE_CACHE_TTL_MS) {
      return cached.rules;
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

    this.ruleCache.set(orgId, { rules: rows as CorrelationRuleRow[], fetchedAt: Date.now() });
    return rows as CorrelationRuleRow[];
  }

  /** Invalidate the rule cache for an org. Call after rule CRUD. */
  invalidateCache(orgId: string): void {
    this.ruleCache.delete(orgId);
  }

  // -------------------------------------------------------------------------
  // Single-rule evaluation
  // -------------------------------------------------------------------------

  private async evaluateRule(
    rule: CorrelationRuleRow,
    event: NormalizedEvent,
  ): Promise<{ candidate: CorrelatedAlertCandidate | null; advanced: boolean; started: boolean }> {
    const config = rule.config as CorrelationRuleConfig;

    // Only sequence type is supported in this phase
    if (config.type !== 'sequence') {
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
      const nextStepIndex = existing.currentStepIndex + 1;

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
              // Save updated instance
              await this.saveInstance(rule.id, keyHash, existing, config.windowMinutes);
              advanced = true;
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
            await this.saveInstance(rule.id, keyHash, existing, config.windowMinutes);
            advanced = true;
          }
        }
      }

      // Check overall window expiration
      if (existing && Date.now() > existing.expiresAt) {
        await this.deleteInstance(rule.id, keyHash, existing.currentStepIndex + 1);
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
          await this.saveInstance(rule.id, keyHash, instance, config.windowMinutes);
          started = true;
        }
      }
    }

    return { candidate, advanced, started };
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
      // No correlation key — use orgId as fallback
      const hash = createHash('sha256').update(event.orgId).digest('hex').slice(0, 16);
      return { hash, values: { orgId: event.orgId } };
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
   * Save a correlation instance to Redis with TTL based on the window.
   */
  private async saveInstance(
    ruleId: string,
    keyHash: string,
    instance: CorrelationInstance,
    windowMinutes: number,
  ): Promise<void> {
    const redisKey = `${SEQ_PREFIX}:${ruleId}:${keyHash}`;
    const ttlMs = windowMinutes * 60_000;

    try {
      const serialized = JSON.stringify(instance);
      await this.redis.set(redisKey, serialized, 'PX', ttlMs);

      // Update step index for quick lookups
      const idxKey = `${IDX_PREFIX}:${ruleId}:${instance.currentStepIndex}:${keyHash}`;
      await this.redis.set(idxKey, '1', 'PX', ttlMs);
    } catch (err) {
      this.log.error({ err, redisKey }, 'Failed to save correlation instance');
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
      actor: (event.payload.actor as string) ?? (event.payload.sender as string) ?? null,
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
