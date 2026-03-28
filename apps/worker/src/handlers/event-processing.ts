/**
 * Core event processing handler.
 * Takes a normalized event, runs it through the RuleEngine,
 * creates alerts, and enqueues notification dispatch.
 */
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { getDb, count, eq } from '@sentinel/db';
import { events, alerts, detections } from '@sentinel/db/schema/core';
import { correlationRules } from '@sentinel/db/schema/correlation';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { RuleEngine } from '@sentinel/shared/rule-engine';
import type { RuleEvaluator, NormalizedEvent } from '@sentinel/shared/rules';
import { logger as rootLogger, type Logger } from '@sentinel/shared/logger';
import type { Redis } from 'ioredis';

const EventProcessingPayload = z.object({
  eventId: z.string().uuid('eventId must be a valid UUID'),
});

export function createEventProcessingHandler(
  evaluators: Map<string, RuleEvaluator>,
  redis: Redis,
  log?: Logger,
): JobHandler {
  const db = getDb();
  const _log = log ?? rootLogger.child({ component: 'event-processing' });
  const engine = new RuleEngine({ evaluators, redis, db, logger: _log });

  return {
    jobName: 'event.evaluate',
    queueName: QUEUE_NAMES.EVENTS,

    async process(job: Job) {
      const parsed = EventProcessingPayload.safeParse(job.data);
      if (!parsed.success) {
        throw new UnrecoverableError(`Invalid event.evaluate payload: ${parsed.error.message}`);
      }
      const { eventId } = parsed.data;

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

      // Evaluate rules
      const result = await engine.evaluate(normalizedEvent);

      // Create alerts and enqueue dispatch
      const alertsQueue = getQueue(QUEUE_NAMES.ALERTS);

      // Bug fix: only enqueue correlation evaluation if the org has at least one
      // active correlation rule. Absence/aggregation/sequence rules still run correctly
      // because the guard is on whether any rules exist at all, not on whether
      // detection-level candidates were produced. This avoids churning the queue
      // for the common case where an org has no correlation rules configured.
      const correlationQueue = getQueue(QUEUE_NAMES.EVENTS);
      const [{ activeRuleCount }] = await db
        .select({ activeRuleCount: count() })
        .from(correlationRules)
        .where(eq(correlationRules.orgId, event.orgId));
      if (activeRuleCount > 0) {
        await correlationQueue.add('correlation.evaluate', { eventId: event.id });
      }

      // Bug fix: wrap all alert inserts + lastTriggeredAt updates for this event
      // in a single transaction. If any insert fails the entire batch rolls back,
      // so a retry will never see a partially-committed set of alerts.
      //
      // Note: for true idempotency against a retry that fires *after* the
      // transaction commits but *before* all dispatch jobs are enqueued, a
      // unique DB constraint on (event_id, detection_id, rule_id) would be the
      // definitive fix. Until that migration is added, the transaction boundary
      // is sufficient to prevent the partial-insert duplicate reported here.
      const createdAlerts: Array<{ id: bigint; detectionId: string | null }> = [];
      if (result.candidates.length > 0) {
        try {
          await db.transaction(async (tx) => {
            for (const candidate of result.candidates) {
              // Use ON CONFLICT DO NOTHING to rely on the DB unique constraint
              // (uq_alerts_event_detection_rule) for deduplication instead of
              // the previous SELECT-before-INSERT pattern, which was racy.
              const [alert] = await tx.insert(alerts).values({
                orgId: candidate.orgId,
                detectionId: candidate.detectionId,
                ruleId: candidate.ruleId,
                eventId: candidate.eventId,
                severity: candidate.severity,
                title: candidate.title,
                description: candidate.description,
                triggerType: candidate.triggerType,
                triggerData: candidate.triggerData,
              })
                .onConflictDoNothing()
                .returning();

              if (!alert) {
                // Duplicate detected by constraint — skip this candidate
                _log.debug({ eventId: candidate.eventId, detectionId: candidate.detectionId, ruleId: candidate.ruleId }, 'Duplicate alert suppressed by constraint');
                continue;
              }

              // Always update lastTriggeredAt so the DB stays in sync for Redis failover
              if (candidate.detectionId) {
                await tx.update(detections)
                  .set({ lastTriggeredAt: new Date() })
                  .where(eq(detections.id, candidate.detectionId));
              }

              createdAlerts.push({ id: alert.id, detectionId: candidate.detectionId });
            }
          });
        } catch (err) {
          _log.error({ err, eventId: event.id, candidateCount: result.candidates.length }, 'Alert batch insert failed — transaction rolled back');
        }

        // Enqueue dispatch outside the transaction so queue writes are not
        // rolled back if a later candidate insert fails. Alerts that were
        // committed are dispatched; a subsequent retry will see none of them
        // if the transaction rolled back.
        for (const created of createdAlerts) {
          try {
            await alertsQueue.add('alert.dispatch', { alertId: String(created.id) });
          } catch (err) {
            _log.error({ err, alertId: String(created.id) }, 'Failed to enqueue alert dispatch');
          }
        }
      }
    },
  };
}
