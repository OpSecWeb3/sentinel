/**
 * Correlation expiry handler.
 * Background job that finds expired absence triggers (via a Redis sorted set
 * index) and creates alerts when the expected event never arrived.
 * Runs on the DEFERRED queue on a scheduled interval.
 */
import type { Job } from 'bullmq';
import { getDb } from '@sentinel/db';
import { alerts } from '@sentinel/db/schema/core';
import { correlationRules } from '@sentinel/db/schema/correlation';
import { eq, and, sql } from '@sentinel/db';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import type { CorrelationRuleConfig, CorrelationInstance } from '@sentinel/shared/correlation-types';
import { ABSENCE_INDEX_KEY } from '@sentinel/shared/correlation-engine';
import { logger as rootLogger, type Logger } from '@sentinel/shared/logger';
import type { Redis } from 'ioredis';

const ABSENCE_KEY_PREFIX = 'sentinel:corr:absence:';

/**
 * Maximum number of expired keys to process per sweep invocation.
 * Prevents the job from monopolising the deferred queue on large backlogs.
 */
const INDEX_BATCH_SIZE = 500;

/**
 * How often the SCAN fallback runs relative to normal sweeps.
 * The SCAN fallback catches any keys that were written without the sorted
 * set index (e.g. during a deploy transition). We run it less frequently
 * because ZRANGEBYSCORE handles the steady-state case efficiently.
 */
const SCAN_FALLBACK_INTERVAL_MS = 30 * 60_000; // 30 minutes

const SCAN_BATCH_SIZE = 100;
const MAX_SCAN_ITERATIONS = 1_000;

/**
 * Per-key processing lock TTL.
 * Must be long enough to cover a full DB insert + queue enqueue cycle.
 * 30 s is conservative but safe — the sweep itself runs every 5 minutes.
 */
const EXPIRY_LOCK_TTL_MS = 30_000;

/**
 * Maximum number of consecutive DB-insert failures for a single key before
 * we log an alert-level warning. The retryCount is stored inside the
 * serialised instance so it persists across sweeps.
 */
const MAX_RETRY_ALERT_THRESHOLD = 5;

/** Redis key used to persist the last SCAN fallback timestamp across restarts. */
const LAST_SCAN_FALLBACK_KEY = 'sentinel:corr:last-scan-fallback';

export function createCorrelationExpiryHandler(redis: Redis, log?: Logger): JobHandler {
  const _log = log ?? rootLogger.child({ component: 'correlation-expiry' });
  return {
    jobName: 'correlation.expiry',
    queueName: QUEUE_NAMES.DEFERRED,

    async process(job: Job) {
      const db = getDb();
      const alertsQueue = getQueue(QUEUE_NAMES.ALERTS);
      const now = Date.now();

      let processedCount = 0;
      let alertsCreated = 0;

      // ── Primary path: sorted set index ──────────────────────────────
      // ZRANGEBYSCORE returns keys whose expiresAt <= now, limited to
      // INDEX_BATCH_SIZE per invocation. This is O(log N + M) where M is
      // the number of results — far cheaper than scanning the keyspace.
      const expiredKeys: string[] = await redis.zrangebyscore(
        ABSENCE_INDEX_KEY,
        '-inf',
        String(now),
        'LIMIT',
        0,
        INDEX_BATCH_SIZE,
      );

      for (const key of expiredKeys) {
        const result = await processAbsenceKey(key, redis, db, alertsQueue, now, _log);
        if (result === 'created') alertsCreated++;
        if (result !== 'skipped') processedCount++;
      }

      // ── Fallback: periodic SCAN for un-indexed keys ─────────────────
      // Catches keys written before the sorted set index was deployed.
      // Timestamp is persisted in Redis so it survives worker restarts.
      const lastScanRaw = await redis.get(LAST_SCAN_FALLBACK_KEY);
      const lastScanFallbackAt = lastScanRaw ? Number(lastScanRaw) : 0;
      if (now - lastScanFallbackAt >= SCAN_FALLBACK_INTERVAL_MS) {
        await redis.set(LAST_SCAN_FALLBACK_KEY, String(now));
        const scanResult = await scanFallback(redis, db, alertsQueue, now, _log);
        processedCount += scanResult.processed;
        alertsCreated += scanResult.created;
      }

      if (processedCount > 0 || alertsCreated > 0) {
        _log.info({ processedCount, alertsCreated }, 'Expiry sweep complete');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Per-key processing (shared by index path and SCAN fallback)
// ---------------------------------------------------------------------------

type ProcessResult = 'created' | 'processed' | 'skipped';

async function processAbsenceKey(
  key: string,
  redis: Redis,
  db: ReturnType<typeof getDb>,
  alertsQueue: ReturnType<typeof getQueue>,
  now: number,
  _log: Logger,
): Promise<ProcessResult> {
  try {
    // Acquire per-key lock
    const lockKey = `${key}:processing-lock`;
    const lockAcquired = await redis.set(lockKey, '1', 'PX', EXPIRY_LOCK_TTL_MS, 'NX');
    if (!lockAcquired) return 'skipped';

    const raw = await redis.get(key);
    if (!raw) {
      await redis.del(lockKey);
      // Clean up stale index entry
      await redis.zrem(ABSENCE_INDEX_KEY, key);
      return 'skipped';
    }

    const instance: CorrelationInstance = JSON.parse(raw);

    // Skip if not yet expired
    if (instance.expiresAt > now) {
      await redis.del(lockKey);
      return 'skipped';
    }

    // Load the correlation rule
    const [rule] = await db.select()
      .from(correlationRules)
      .where(eq(correlationRules.id, instance.ruleId))
      .limit(1);

    if (!rule || rule.status !== 'active') {
      // Rule deleted or paused — clean up everything
      await redis.del(key, lockKey);
      await redis.zrem(ABSENCE_INDEX_KEY, key);
      return 'processed';
    }

    const config = rule.config as CorrelationRuleConfig;

    // Build absence alert description
    const triggerStepName = instance.matchedSteps.length > 0
      ? instance.matchedSteps[0].stepName
      : 'trigger';
    const expectedEventDesc = config.absence
      ? `${config.absence.expected.eventFilter.moduleId ?? 'any'}:${
          Array.isArray(config.absence.expected.eventFilter.eventType)
            ? config.absence.expected.eventFilter.eventType.join(',')
            : config.absence.expected.eventFilter.eventType ?? 'any'
        }`
      : 'expected event';
    const graceMinutes = config.absence?.graceMinutes ?? config.windowMinutes;

    const title = `[Absence] ${rule.name}: expected event never arrived`;
    const description = [
      `Correlation rule "${rule.name}" detected an absence condition.`,
      `Trigger "${triggerStepName}" was observed but "${expectedEventDesc}" was not received within ${graceMinutes} minutes.`,
      `Correlation key: ${JSON.stringify(instance.correlationKeyValues)}`,
    ].join(' ');

    // ── P3 fix: insert-then-delete ──────────────────────────────────
    // Attempt DB insert FIRST. If it fails, the Redis key survives for
    // the next sweep. Previously the key was deleted before the insert,
    // meaning a failed insert would lose the trigger permanently.
    try {
      const [alert] = await db.insert(alerts).values({
        orgId: instance.orgId,
        detectionId: null,
        ruleId: null,
        eventId: instance.matchedSteps.length > 0 ? instance.matchedSteps[0].eventId : null,
        severity: rule.severity,
        title,
        description,
        triggerType: 'correlated',
        triggerData: {
          correlationType: 'absence',
          correlationRuleId: rule.id,
          correlationKey: instance.correlationKeyValues,
          windowMinutes: config.windowMinutes,
          matchedSteps: instance.matchedSteps,
          sameActor: false,
          actors: instance.matchedSteps.map((s) => s.actor).filter(Boolean) as string[],
          timeSpanMinutes: graceMinutes,
          modules: [...new Set(instance.matchedSteps.map((s) => s.fields.moduleId as string).filter(Boolean))],
        },
      })
        .onConflictDoNothing()
        .returning();

      if (!alert) {
        // Duplicate — constraint caught it. Clean up key + index + lock.
        await redis.del(key, lockKey);
        await redis.zrem(ABSENCE_INDEX_KEY, key);
        return 'processed';
      }

      // Update lastTriggeredAt on the correlation rule
      await db.update(correlationRules)
        .set({ lastTriggeredAt: new Date() })
        .where(eq(correlationRules.id, rule.id));

      // Enqueue notification dispatch
      await alertsQueue.add('alert.dispatch', { alertId: String(alert.id) });

      // Insert succeeded — now safe to delete the Redis key + index + lock
      await redis.del(key, lockKey);
      await redis.zrem(ABSENCE_INDEX_KEY, key);

      _log.info({ alertId: alert.id, ruleId: rule.id, correlationKey: instance.correlationKeyValues }, 'Created absence alert');
      return 'created';
    } catch (insertErr) {
      // DB insert failed — leave the Redis key alive for the next sweep.
      // Only delete the processing lock so the key can be retried.
      await redis.del(lockKey);

      // Track retryCount in the serialised instance so we can detect keys
      // that repeatedly fail and alert on them.
      const retryCount = ((instance as any).retryCount ?? 0) + 1;
      (instance as any).retryCount = retryCount;
      const ttlMs = await redis.pttl(key);
      if (ttlMs > 0) {
        await redis.set(key, JSON.stringify(instance), 'PX', ttlMs);
      }

      if (retryCount >= MAX_RETRY_ALERT_THRESHOLD) {
        _log.error({ err: insertErr, redisKey: key, retryCount }, 'Absence key repeatedly failing DB insert — possible data issue');
      } else {
        _log.warn({ err: insertErr, redisKey: key, retryCount }, 'DB insert failed for absence key — will retry on next sweep');
      }
      return 'processed';
    }
  } catch (err) {
    _log.error({ err, redisKey: key }, 'Failed to process expiry key');
    return 'skipped';
  }
}

// ---------------------------------------------------------------------------
// SCAN fallback — catches un-indexed keys (e.g. from before the index deploy)
// ---------------------------------------------------------------------------

async function scanFallback(
  redis: Redis,
  db: ReturnType<typeof getDb>,
  alertsQueue: ReturnType<typeof getQueue>,
  now: number,
  _log: Logger,
): Promise<{ processed: number; created: number }> {
  let cursor = '0';
  let processed = 0;
  let created = 0;
  let scanIterations = 0;

  do {
    if (scanIterations >= MAX_SCAN_ITERATIONS) {
      _log.warn({ scanIterations, processed, created }, 'SCAN fallback hit iteration cap; deferring to next run');
      break;
    }
    scanIterations++;

    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH', `${ABSENCE_KEY_PREFIX}*`,
      'COUNT', SCAN_BATCH_SIZE,
    );
    cursor = nextCursor;

    for (const key of keys) {
      // Ensure the key is in the sorted set index for future sweeps
      const raw = await redis.get(key);
      if (raw) {
        try {
          const instance: CorrelationInstance = JSON.parse(raw);
          // Re-index — idempotent ZADD
          await redis.zadd(ABSENCE_INDEX_KEY, instance.expiresAt, key);
        } catch {
          // Skip corrupted entries — they'll be cleaned up by processAbsenceKey
        }
      }

      const result = await processAbsenceKey(key, redis, db, alertsQueue, now, _log);
      if (result === 'created') created++;
      if (result !== 'skipped') processed++;
    }
  } while (cursor !== '0');

  if (processed > 0) {
    _log.info({ processed, created }, 'SCAN fallback sweep complete');
  }

  return { processed, created };
}
