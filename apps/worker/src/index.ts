import IORedis from 'ioredis';
import { env } from '@sentinel/shared/env';
import { createLogger } from '@sentinel/shared/logger';
import { initSentry, setupGlobalHandlers } from '@sentinel/shared/sentry';
import { setSharedConnection, setConnectionFactory, createWorker, getQueue, QUEUE_NAMES, closeAllQueues, type JobHandler } from '@sentinel/shared/queue';
import type { RuleEvaluator } from '@sentinel/shared/rules';
import { getDb, closeDb } from '@sentinel/db';

// Core handlers
import { createEventProcessingHandler } from './handlers/event-processing.js';
import { alertDispatchHandler, setModuleFormatters } from './handlers/alert-dispatch.js';
import { dataRetentionHandler, DEFAULT_RETENTION_POLICIES } from './handlers/data-retention.js';
import { createCorrelationHandler } from './handlers/correlation-evaluate.js';
import { createCorrelationExpiryHandler } from './handlers/correlation-expiry.js';
import { pollSweepHandler } from './handlers/poll-sweep.js';
import { sessionCleanupHandler } from './handlers/session-cleanup.js';
import { keyRotationHandler } from './handlers/key-rotation.js';

// Module imports
import { GitHubModule } from '@sentinel/module-github';
import { RegistryModule } from '@sentinel/module-registry';
import { ChainModule } from '@sentinel/module-chain';
import { InfraModule } from '@sentinel/module-infra';
import { AwsModule } from '@sentinel/module-aws';

// Platform-level evaluators
import { compoundEvaluator } from '@sentinel/shared/evaluators/compound';

const config = env();
const log = createLogger({ service: 'sentinel-worker', level: config.LOG_LEVEL });

async function main() {
  await initSentry({
    dsn: config.SENTRY_DSN,
    service: 'sentinel-worker',
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
  });
  setupGlobalHandlers(log);

  // Initialise Sigstore trust material for registry signature verification
  const { initVerification } = await import('@sentinel/module-registry');
  await initVerification();

  log.info('Starting Sentinel workers');

  // ── Startup connectivity checks ─────────────────────────────────────
  // Fail fast if infrastructure is unreachable rather than silently failing
  // on every job. Docker will restart us via unless-stopped policy.
  const redis = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  // Shared connection for Queue instances (producers) and general use.
  setSharedConnection(redis);

  // Connection factory for Workers — each Worker gets its own dedicated Redis
  // connection to avoid head-of-line blocking on the blocking BRPOPLPUSH that
  // BullMQ workers use. Without this, all workers share one connection and a
  // slow consumer on one queue can stall job delivery to all other queues.
  setConnectionFactory(() => new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }));

  // Verify Redis is reachable before proceeding
  try {
    await redis.ping();
    log.info('Startup: Redis connected');
  } catch (err) {
    log.fatal({ err }, 'Startup: Redis unreachable — aborting');
    process.exit(1);
  }

  // Init database — worker processes use a larger pool to support concurrent
  // BullMQ job processing across all queues (events=15, alerts=15, etc.).
  // Total concurrency across all workers: EVENTS=15 + ALERTS=15 + MODULE_JOBS=10 + DEFERRED=5 = 45.
  // Size the pool to match so jobs never block waiting for a connection.
  getDb(undefined, { maxConnections: 50 });

  // Verify DB is reachable
  try {
    const { sql: dbSql } = await import('@sentinel/db');
    const db = getDb();
    await db.execute(dbSql`SELECT 1`);
    log.info('Startup: database connected');
  } catch (err) {
    log.fatal({ err }, 'Startup: database unreachable — aborting');
    process.exit(1);
  }

  // ── Register modules ────────────────────────────────────────────────
  const modules = [GitHubModule, RegistryModule, ChainModule, InfraModule, AwsModule];

  // Build evaluator registry
  const evaluators = new Map<string, RuleEvaluator>();
  for (const mod of modules) {
    for (const evaluator of mod.evaluators) {
      const key = `${evaluator.moduleId}:${evaluator.ruleType}`;
      evaluators.set(key, evaluator);
      log.info({ evaluator: key }, 'Registered evaluator');
    }
  }

  // Register module Slack formatters for alert dispatch
  setModuleFormatters(modules);

  // Register platform-level evaluators
  const compoundKey = `${compoundEvaluator.moduleId}:${compoundEvaluator.ruleType}`;
  evaluators.set(compoundKey, compoundEvaluator);
  log.info({ evaluator: compoundKey }, 'Registered evaluator');

  // ── Collect all job handlers ────────────────────────────────────────
  const coreHandlers: JobHandler[] = [
    createEventProcessingHandler(evaluators, redis),
    createCorrelationHandler(redis),
    createCorrelationExpiryHandler(redis),
    alertDispatchHandler,
    dataRetentionHandler,
    pollSweepHandler,
    sessionCleanupHandler,
    keyRotationHandler,
  ];

  const moduleHandlers = modules.flatMap((m) => m.jobHandlers);
  const allHandlers = [...coreHandlers, ...moduleHandlers];

  // ── Group handlers by queue ─────────────────────────────────────────
  const handlersByQueue = new Map<string, JobHandler[]>();
  for (const h of allHandlers) {
    const existing = handlersByQueue.get(h.queueName) ?? [];
    existing.push(h);
    handlersByQueue.set(h.queueName, existing);
  }

  // ── Dead-letter queue for permanently failed jobs ────────────────────
  const deadLetterQueue = getQueue('sentinel:dead-letter');

  // ── Metrics ─────────────────────────────────────────────────────────
  const { jobsProcessedTotal, jobDuration, deadLetterTotal, queueDepth } = await import('@sentinel/shared/metrics');

  // ── Start workers ───────────────────────────────────────────────────
  const workers: Awaited<ReturnType<typeof createWorker>>[] = [];
  for (const [queueName, handlers] of handlersByQueue) {
    const concurrency =
      queueName === QUEUE_NAMES.EVENTS ? 15 :
      queueName === QUEUE_NAMES.ALERTS ? 15 :
      queueName === QUEUE_NAMES.MODULE_JOBS ? 10 : 5;
    const worker = createWorker(queueName, handlers, { concurrency });

    worker.on('completed', (job) => {
      log.debug({ queue: queueName, jobName: job.name, jobId: job.id }, 'Job completed');
      jobsProcessedTotal.inc({ queue: queueName, jobName: job.name, status: 'completed' });
    });

    worker.on('failed', (job, err) => {
      const jobName = job?.name ?? 'unknown';
      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = (job?.opts?.attempts ?? 3);

      log.error({ queue: queueName, jobName, jobId: job?.id, attemptsMade, err }, 'Job failed');
      jobsProcessedTotal.inc({ queue: queueName, jobName, status: 'failed' });

      // Move to dead-letter queue after exhausting all retries
      if (attemptsMade >= maxAttempts) {
        deadLetterQueue.add('dead-letter', {
          originalQueue: queueName,
          jobName,
          jobId: job?.id,
          data: job?.data,
          error: err?.message,
          failedAt: new Date().toISOString(),
          attemptsMade,
        }, {
          removeOnComplete: false,  // Keep dead-letter jobs for inspection
          removeOnFail: false,
          attempts: 1,              // Don't retry dead-letter entries
        }).catch((dlErr) => {
          log.error({ dlErr, jobName, jobId: job?.id }, 'Failed to enqueue dead-letter job');
        });
        deadLetterTotal.inc({ queue: queueName, jobName });
        log.warn({ queue: queueName, jobName, jobId: job?.id, attemptsMade }, 'Job moved to dead-letter queue after exhausting retries');
      }
    });

    workers.push(worker);
    log.info({ queue: queueName, concurrency, handlers: handlers.map((h) => h.jobName) }, 'Started worker');
  }

  // ── Periodic queue depth reporting ─────────────────────────────────
  setInterval(async () => {
    for (const [queueName] of handlersByQueue) {
      try {
        const q = getQueue(queueName);
        const waiting = await q.getWaitingCount();
        queueDepth.set({ queue: queueName }, waiting);
      } catch { /* best effort */ }
    }
  }, 15_000);

  // ── Schedule daily data retention cleanup ───────────────────────────
  const deferredQueue = getQueue(QUEUE_NAMES.DEFERRED);

  // Use upsertJobScheduler to atomically create-or-update repeatable jobs.
  // This avoids the remove-then-add race that could occur when multiple
  // replicas start simultaneously during a rolling deploy.
  await deferredQueue.upsertJobScheduler(
    'daily-retention',
    { every: 86_400_000 },
    {
      name: 'platform.data.retention',
      data: { policies: [...DEFAULT_RETENTION_POLICIES, ...modules.flatMap(m => m.retentionPolicies ?? [])] },
    },
  );

  // ── Schedule session garbage collection every hour ─────────────────
  await deferredQueue.upsertJobScheduler(
    'session-cleanup',
    { every: 3_600_000 },
    { name: 'platform.session.cleanup', data: {} },
  );

  // ── Schedule encryption key rotation every 5 minutes ────────────────
  await deferredQueue.upsertJobScheduler(
    'key-rotation',
    { every: 300_000 },
    { name: 'platform.key.rotation', data: {} },
  );

  // ── Schedule correlation expiry sweep every 5 minutes ───────────────
  await deferredQueue.upsertJobScheduler(
    'correlation-expiry-sweep',
    { every: 300_000 },
    { name: 'correlation.expiry', data: {} },
  );

  // ── Schedule RPC usage flush every 5 minutes ────────────────────────
  const moduleJobsQueue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await moduleJobsQueue.upsertJobScheduler(
    'rpc-usage-flush',
    { every: 300_000 },
    { name: 'chain.rpc-usage.flush', data: {} },
  );

  // ── Schedule registry artifact poll sweep every 60 seconds ─────
  await moduleJobsQueue.upsertJobScheduler(
    'registry-poll-sweep',
    { every: 60_000 },
    { name: 'registry.poll-sweep', data: {} },
  );

  // ── Schedule AWS SQS poll sweep every 60 seconds ─────────────────────
  await moduleJobsQueue.upsertJobScheduler(
    'aws-poll-sweep',
    { every: 60_000 },
    { name: 'aws.poll-sweep', data: {} },
  );

  // ── Schedule infra scan/probe loader every 60 seconds ───────────────
  await moduleJobsQueue.upsertJobScheduler(
    'infra-schedule-load',
    { every: 60_000 },
    { name: 'infra.schedule.load', data: {} },
  );

  // ── Graceful shutdown ───────────────────────────────────────────────
  async function shutdown(signal: string) {
    log.info({ signal }, 'Shutting down');
    // closeAllQueues() closes all tracked Workers AND Queues in one pass.
    // Previously workers were closed here AND inside closeAllQueues(), causing
    // a double-close that could reject or leave connections dangling.
    await closeAllQueues();
    await redis.quit();
    await closeDb();
    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error');
  process.exit(1);
});
