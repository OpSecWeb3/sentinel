/**
 * Core event processing handler.
 * Takes a normalized event, runs it through the RuleEngine,
 * creates alerts, and enqueues notification dispatch.
 */
import type { Job } from 'bullmq';
import { getDb } from '@sentinel/db';
import { events, alerts, detections } from '@sentinel/db/schema/core';
import { eq } from '@sentinel/db';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { RuleEngine } from '@sentinel/shared/rule-engine';
import type { RuleEvaluator, NormalizedEvent } from '@sentinel/shared/rules';
import { logger as rootLogger, type Logger } from '@sentinel/shared/logger';
import type { Redis } from 'ioredis';

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

      // Evaluate rules
      const result = await engine.evaluate(normalizedEvent);

      // Create alerts and enqueue dispatch
      const alertsQueue = getQueue(QUEUE_NAMES.ALERTS);

      // Enqueue correlation evaluation (runs in parallel with alert creation)
      const correlationQueue = getQueue(QUEUE_NAMES.EVENTS);
      await correlationQueue.add('correlation.evaluate', { eventId: event.id });

      for (const candidate of result.candidates) {
        try {
          const [alert] = await db.insert(alerts).values({
            orgId: candidate.orgId,
            detectionId: candidate.detectionId,
            ruleId: candidate.ruleId,
            eventId: candidate.eventId,
            severity: candidate.severity,
            title: candidate.title,
            description: candidate.description,
            triggerType: candidate.triggerType,
            triggerData: candidate.triggerData,
          }).returning();

          // Always update lastTriggeredAt so the DB stays in sync for Redis failover
          if (candidate.detectionId) {
            await db.update(detections)
              .set({ lastTriggeredAt: new Date() })
              .where(eq(detections.id, candidate.detectionId));
          }

          // Enqueue notification dispatch
          await alertsQueue.add('alert.dispatch', { alertId: String(alert.id) });
        } catch (err) {
          _log.error({ err, detectionId: candidate.detectionId }, 'Failed to create alert');
        }
      }
    },
  };
}
