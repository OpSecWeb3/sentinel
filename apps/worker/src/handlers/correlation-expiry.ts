/**
 * Correlation expiry handler.
 * Background job that scans Redis for expired absence triggers
 * and creates alerts when the expected event never arrived.
 * Runs on the DEFERRED queue on a scheduled interval.
 */
import type { Job } from 'bullmq';
import { getDb } from '@sentinel/db';
import { alerts } from '@sentinel/db/schema/core';
import { correlationRules } from '@sentinel/db/schema/correlation';
import { eq } from '@sentinel/db';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import type { CorrelationRuleConfig, CorrelationInstance } from '@sentinel/shared/correlation-types';
import { logger as rootLogger, type Logger } from '@sentinel/shared/logger';
import type { Redis } from 'ioredis';

const ABSENCE_KEY_PREFIX = 'sentinel:corr:absence:';
const SCAN_BATCH_SIZE = 100;

export function createCorrelationExpiryHandler(redis: Redis, log?: Logger): JobHandler {
  const _log = log ?? rootLogger.child({ component: 'correlation-expiry' });
  return {
    jobName: 'correlation.expiry',
    queueName: QUEUE_NAMES.DEFERRED,

    async process(job: Job) {
      const db = getDb();
      const alertsQueue = getQueue(QUEUE_NAMES.ALERTS);
      const now = Date.now();

      let cursor = '0';
      let processedCount = 0;
      let alertsCreated = 0;

      do {
        // Scan for absence trigger keys
        const [nextCursor, keys] = await redis.scan(
          cursor,
          'MATCH', `${ABSENCE_KEY_PREFIX}*`,
          'COUNT', SCAN_BATCH_SIZE,
        );
        cursor = nextCursor;

        for (const key of keys) {
          try {
            const raw = await redis.get(key);
            if (!raw) continue;

            const instance: CorrelationInstance = JSON.parse(raw);

            // Skip if not yet expired
            if (instance.expiresAt > now) continue;

            processedCount++;

            // Load the correlation rule
            const [rule] = await db.select()
              .from(correlationRules)
              .where(eq(correlationRules.id, instance.ruleId))
              .limit(1);

            if (!rule || rule.status !== 'active') {
              // Rule deleted or paused — clean up and skip
              await redis.del(key);
              continue;
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

            // Create absence alert
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
            }).returning();

            // Update lastTriggeredAt on the correlation rule
            await db.update(correlationRules)
              .set({ lastTriggeredAt: new Date() })
              .where(eq(correlationRules.id, rule.id));

            // Enqueue notification dispatch
            await alertsQueue.add('alert.dispatch', { alertId: String(alert.id) });

            alertsCreated++;

            // Clean up Redis state
            await redis.del(key);

            _log.info({ alertId: alert.id, ruleId: rule.id, correlationKey: instance.correlationKeyValues }, 'Created absence alert');
          } catch (err) {
            _log.error({ err, redisKey: key }, 'Failed to process expiry key');
          }
        }
      } while (cursor !== '0');

      if (processedCount > 0 || alertsCreated > 0) {
        _log.info({ processedCount, alertsCreated }, 'Expiry sweep complete');
      }
    },
  };
}
