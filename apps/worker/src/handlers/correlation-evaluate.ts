/**
 * Correlation evaluation handler.
 * Takes a normalized event, runs it through the CorrelationEngine,
 * creates correlated alerts, and enqueues notification dispatch.
 */
import type { Job } from 'bullmq';
import { getDb, eq, and, sql } from '@sentinel/db';
import { events, alerts } from '@sentinel/db/schema/core';
import { correlationRules } from '@sentinel/db/schema/correlation';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { CorrelationEngine } from '@sentinel/shared/correlation-engine';
import type { NormalizedEvent } from '@sentinel/shared/rules';
import type { CorrelatedAlertCandidate } from '@sentinel/shared/correlation-types';
import { logger as rootLogger, type Logger } from '@sentinel/shared/logger';
import type { Redis } from 'ioredis';

export function createCorrelationHandler(redis: Redis, log?: Logger): JobHandler {
  const db = getDb();
  const _log = log ?? rootLogger.child({ component: 'correlation-evaluate' });
  const engine = new CorrelationEngine({ redis, db, logger: _log });

  return {
    jobName: 'correlation.evaluate',
    queueName: QUEUE_NAMES.EVENTS,

    async process(job: Job) {
      const { eventId } = job.data as { eventId: string };

      // Load event
      const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
      if (!event) return;

      // Build normalized event
      const normalizedEvent: NormalizedEvent = {
        id: event.id,
        orgId: event.orgId,
        moduleId: event.moduleId,
        eventType: event.eventType,
        externalId: event.externalId,
        payload: event.payload as Record<string, unknown>,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
      };

      // Evaluate correlation rules
      const result = await engine.evaluate(normalizedEvent);

      // Create alerts and enqueue dispatch
      const alertsQueue = getQueue(QUEUE_NAMES.ALERTS);

      for (const candidate of result.candidates) {
        try {
          // Use ON CONFLICT DO NOTHING backed by the DB unique constraint
          // (uq_alerts_event_correlation) instead of a SELECT-then-INSERT
          // guard which was racy under concurrent job retries.
          const [alert] = await db.insert(alerts).values({
            orgId: candidate.orgId,
            detectionId: null,
            ruleId: null,
            eventId: normalizedEvent.id,
            severity: candidate.severity,
            title: candidate.title,
            description: candidate.description,
            triggerType: candidate.triggerType,
            triggerData: {
              ...candidate.triggerData,
              correlationRuleId: candidate.correlationRuleId,
            },
          })
            .onConflictDoNothing()
            .returning();

          let alertId: string;

          if (!alert) {
            // Duplicate suppressed by constraint — still re-enqueue dispatch
            // in case that was the step that failed on the previous attempt.
            const [existing] = await db
              .select({ id: alerts.id })
              .from(alerts)
              .where(
                and(
                  eq(alerts.eventId, normalizedEvent.id),
                  eq(alerts.triggerType, 'correlated'),
                  sql`${alerts.triggerData}->>'correlationRuleId' = ${candidate.correlationRuleId}`,
                ),
              )
              .limit(1);

            if (!existing) continue; // shouldn't happen, but guard defensively
            alertId = String(existing.id);
            _log.warn({ alertId, correlationRuleId: candidate.correlationRuleId }, 'Correlated alert already exists, re-enqueueing dispatch');
          } else {
            alertId = String(alert.id);

            // Update lastTriggeredAt on the correlation rule
            await db.update(correlationRules)
              .set({ lastTriggeredAt: new Date() })
              .where(eq(correlationRules.id, candidate.correlationRuleId));

            _log.info({ alertId, correlationRuleId: candidate.correlationRuleId, correlationType: candidate.triggerData.correlationType }, 'Created correlated alert');
          }

          // Enqueue notification dispatch (idempotent re-enqueue on retry)
          await alertsQueue.add('alert.dispatch', { alertId });
        } catch (err) {
          _log.error({ err, correlationRuleId: candidate.correlationRuleId }, 'Failed to create correlated alert');
        }
      }

      if (result.candidates.length > 0) {
        _log.info({ eventId, alertCount: result.candidates.length, advanced: result.advancedRuleIds.size, started: result.startedRuleIds.size }, 'Correlation evaluation complete');
      }
    },
  };
}
