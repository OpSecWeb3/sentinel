/**
 * RuleEngine — centralized rule evaluation for all modules.
 *
 * Handles: rule loading, evaluator resolution, config validation,
 * cooldown enforcement (Redis + DB fallback), priority ordering,
 * suppress/log/alert actions, and cooldown lock cleanup.
 *
 * Returns AlertCandidates — the caller is responsible for DB writes
 * and job enqueueing. This keeps the engine testable.
 */
import { eq, and, asc, or, isNull, lt } from '@sentinel/db';
import { detections, rules } from '@sentinel/db/schema/core';
import type { Redis } from 'ioredis';
import type { Db } from '@sentinel/db';
import { minimatch } from 'minimatch';
import type {
  RuleEvaluator,
  AlertCandidate,
  NormalizedEvent,
  RuleRow,
  DetectionRow,
  ResourceFilter,
} from './rules.js';
import { logger as rootLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuleEngineConfig {
  evaluators: Map<string, RuleEvaluator>;
  redis: Redis;
  db: Db;
  logger?: Logger;
}

export interface EvaluationResult {
  /** Alert candidates produced by rules with action='alert'. */
  candidates: AlertCandidate[];
  /** Whether a suppress rule fired, stopping further evaluation. */
  suppressed: boolean;
  /** Detection IDs that acquired cooldown locks (Redis or DB). */
  acquiredCooldownLocks: Set<string>;
  /** Detection IDs that produced alert candidates. */
  alertedDetectionIds: Set<string>;
}

// ---------------------------------------------------------------------------
// RuleEngine
// ---------------------------------------------------------------------------

export class RuleEngine {
  private readonly evaluators: Map<string, RuleEvaluator>;
  private readonly redis: Redis;
  private readonly db: Db;
  private readonly log: Logger;

  constructor(config: RuleEngineConfig) {
    this.evaluators = config.evaluators;
    this.redis = config.redis;
    this.db = config.db;
    this.log = config.logger ?? rootLogger.child({ component: 'rule-engine' });
  }

  /**
   * Load active rules for an org+module, ordered by priority (lowest first).
   */
  async loadRules(
    orgId: string,
    moduleId: string,
  ): Promise<Array<{ rule: typeof rules.$inferSelect; detection: typeof detections.$inferSelect }>> {
    return this.db
      .select({ rule: rules, detection: detections })
      .from(rules)
      .innerJoin(detections, eq(detections.id, rules.detectionId))
      .where(
        and(
          eq(rules.orgId, orgId),
          eq(rules.moduleId, moduleId),
          eq(rules.status, 'active'),
          eq(detections.status, 'active'),
        ),
      )
      .orderBy(asc(rules.priority));
  }

  /**
   * Build the Redis cooldown key. Override point for per-resource cooldowns (Phase 1.2).
   */
  protected cooldownKey(detectionId: string, _ruleId: string, resourceId?: string): string {
    const base = `sentinel:cooldown:${detectionId}:${_ruleId}`;
    return resourceId ? `${base}:${resourceId}` : base;
  }

  /**
   * Evaluate an event against all active rules for its org+module.
   */
  async evaluate(event: NormalizedEvent): Promise<EvaluationResult> {
    const activeRules = await this.loadRules(event.orgId, event.moduleId);

    const candidates: AlertCandidate[] = [];
    let suppressed = false;
    const acquiredCooldownLocks = new Set<string>();
    const resourceId = (event.payload?.resourceId as string) ?? undefined;

    for (const { rule, detection } of activeRules) {
      if (suppressed) break;

      // Resolve evaluator
      const key = `${rule.moduleId}:${rule.ruleType}`;
      const evaluator = this.evaluators.get(key);
      if (!evaluator) continue;

      // Validate config
      const parsed = evaluator.configSchema.safeParse(rule.config);
      if (!parsed.success) continue;

      // Resource filter (Phase 1.3 hook — checks rule.config.resourceFilter)
      if (resourceId != null && !this.passesResourceFilter(rule.config, resourceId)) {
        continue;
      }

      // Cooldown check
      if (detection.cooldownMinutes > 0) {
        const acquired = await this.checkCooldown(
          detection,
          rule.id,
          resourceId,
        );
        if (!acquired) continue;
        acquiredCooldownLocks.add(detection.id);
      }

      // Evaluate
      try {
        const candidate = await evaluator.evaluate({
          event,
          rule: {
            ...rule,
            config: rule.config as Record<string, unknown>,
          } as RuleRow,
          redis: this.redis,
          resourceId,
          evaluators: this.evaluators,
        });

        if (!candidate) continue;

        switch (rule.action) {
          case 'alert':
            candidates.push(candidate);
            break;
          case 'suppress':
            suppressed = true;
            break;
          // 'log' — event already stored, nothing more to do
        }
      } catch (err) {
        this.log.error({ err, ruleId: rule.id }, 'Error evaluating rule');
      }
    }

    // Determine which detections produced alerts
    const alertedDetectionIds = new Set(candidates.map((c) => c.detectionId));

    // Release Redis cooldown locks for detections that did NOT produce an alert
    await this.cleanupUnusedLocks(acquiredCooldownLocks, alertedDetectionIds);

    return { candidates, suppressed, acquiredCooldownLocks, alertedDetectionIds };
  }

  /**
   * Evaluate an event against a specific detection's rules without side effects.
   * Skips cooldowns, never writes to DB or Redis. Used for dry-run / test API.
   */
  async evaluateDryRun(
    event: NormalizedEvent,
    detectionId: string,
  ): Promise<EvaluationResult> {
    // Load only rules for this detection
    const activeRules = await this.db
      .select({ rule: rules, detection: detections })
      .from(rules)
      .innerJoin(detections, eq(detections.id, rules.detectionId))
      .where(
        and(
          eq(rules.detectionId, detectionId),
          eq(rules.status, 'active'),
          eq(detections.status, 'active'),
        ),
      )
      .orderBy(asc(rules.priority));

    const candidates: AlertCandidate[] = [];
    let suppressed = false;
    const resourceId = (event.payload?.resourceId as string) ?? undefined;

    for (const { rule, detection } of activeRules) {
      if (suppressed) break;

      const key = `${rule.moduleId}:${rule.ruleType}`;
      const evaluator = this.evaluators.get(key);
      if (!evaluator) continue;

      const parsed = evaluator.configSchema.safeParse(rule.config);
      if (!parsed.success) continue;

      if (resourceId != null && !this.passesResourceFilter(rule.config, resourceId)) {
        continue;
      }

      // No cooldown check — dry run

      try {
        const candidate = await evaluator.evaluate({
          event,
          rule: {
            ...rule,
            config: rule.config as Record<string, unknown>,
          } as RuleRow,
          redis: this.redis,
          resourceId,
          evaluators: this.evaluators,
        });

        if (!candidate) continue;

        switch (rule.action) {
          case 'alert':
            candidates.push(candidate);
            break;
          case 'suppress':
            suppressed = true;
            break;
        }
      } catch (err) {
        this.log.error({ err, ruleId: rule.id }, 'Dry-run: error evaluating rule');
      }
    }

    const alertedDetectionIds = new Set(candidates.map((c) => c.detectionId));
    return { candidates, suppressed, acquiredCooldownLocks: new Set(), alertedDetectionIds };
  }

  /**
   * Check resource filter on rule config. Returns true if the event should be evaluated.
   * Supports glob patterns via minimatch (e.g. "*.prod.*", "org/repo-*").
   */
  protected passesResourceFilter(config: unknown, resourceId: string): boolean {
    const filter = (config as Record<string, unknown>)?.resourceFilter as
      | ResourceFilter
      | undefined;
    if (!filter) return true;

    // Exclude takes precedence
    if (filter.exclude?.some((p) => minimatch(resourceId, p))) return false;

    // If include is specified, resource must match at least one pattern
    if (filter.include && filter.include.length > 0) {
      return filter.include.some((p) => minimatch(resourceId, p));
    }

    return true;
  }

  /**
   * Attempt to acquire cooldown lock. Returns true if acquired (proceed with evaluation).
   */
  private async checkCooldown(
    detection: typeof detections.$inferSelect,
    ruleId: string,
    resourceId?: string,
  ): Promise<boolean> {
    const cooldownMs = detection.cooldownMinutes * 60 * 1000;
    const redisKey = this.cooldownKey(detection.id, ruleId, resourceId);

    try {
      const acquired = await this.redis.set(redisKey, '1', 'PX', cooldownMs, 'NX');
      return !!acquired;
    } catch (err) {
      this.log.debug({ err, detectionId: detection.id }, 'Redis cooldown unavailable, using DB fallback');
      const cooldownThreshold = new Date(Date.now() - cooldownMs);
      const [acquired] = await this.db
        .update(detections)
        .set({ lastTriggeredAt: new Date() })
        .where(
          and(
            eq(detections.id, detection.id),
            or(
              isNull(detections.lastTriggeredAt),
              lt(detections.lastTriggeredAt, cooldownThreshold),
            ),
          ),
        )
        .returning({ id: detections.id });
      return !!acquired;
    }
  }

  /**
   * Release Redis cooldown locks for detections that did not produce alerts.
   */
  private async cleanupUnusedLocks(
    acquired: Set<string>,
    alerted: Set<string>,
  ): Promise<void> {
    for (const detectionId of acquired) {
      if (!alerted.has(detectionId)) {
        try {
          // Scan for all cooldown keys matching this detection and delete them
          const pattern = `sentinel:cooldown:${detectionId}:*`;
          let cursor = '0';
          do {
            const [nextCursor, keys] = await this.redis.scan(
              cursor, 'MATCH', pattern, 'COUNT', 100,
            );
            cursor = nextCursor;
            if (keys.length > 0) {
              await this.redis.del(...keys);
            }
          } while (cursor !== '0');
        } catch (err) {
          this.log.debug({ err, detectionId }, 'Best-effort cooldown lock cleanup failed');
        }
      }
    }
  }
}
