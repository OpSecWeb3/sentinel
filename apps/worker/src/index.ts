import IORedis from 'ioredis';
import { env } from '@sentinel/shared/env';
import { createLogger } from '@sentinel/shared/logger';
import { initSentry, setupGlobalHandlers } from '@sentinel/shared/sentry';
import { setSharedConnection, createWorker, getQueue, QUEUE_NAMES, closeAllQueues, type JobHandler } from '@sentinel/shared/queue';
import type { RuleEvaluator } from '@sentinel/shared/rules';
import { getDb, closeDb } from '@sentinel/db';

// Core handlers
import { createEventProcessingHandler } from './handlers/event-processing.js';
import { alertDispatchHandler, setModuleFormatters } from './handlers/alert-dispatch.js';
import { dataRetentionHandler, DEFAULT_RETENTION_POLICIES } from './handlers/data-retention.js';
import { createCorrelationHandler } from './handlers/correlation-evaluate.js';
import { createCorrelationExpiryHandler } from './handlers/correlation-expiry.js';

// Module imports
import { GitHubModule } from '@sentinel/module-github';
import { ReleaseChainModule } from '@sentinel/module-release-chain';
import { ChainModule } from '@sentinel/module-chain';
import { InfraModule } from '@sentinel/module-infra';

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

  log.info('Starting Sentinel workers');

  const redis = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  setSharedConnection(redis);

  // Init database
  getDb();

  // ── Register modules ────────────────────────────────────────────────
  const modules = [GitHubModule, ReleaseChainModule, ChainModule, InfraModule];

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

  // ── Start workers ───────────────────────────────────────────────────
  const workers: Awaited<ReturnType<typeof createWorker>>[] = [];
  for (const [queueName, handlers] of handlersByQueue) {
    const concurrency = queueName === QUEUE_NAMES.ALERTS ? 10 : 5;
    const worker = createWorker(queueName, handlers, { concurrency });

    worker.on('completed', (job) => {
      log.debug({ queue: queueName, jobName: job.name, jobId: job.id }, 'Job completed');
    });
    worker.on('failed', (job, err) => {
      log.error({ queue: queueName, jobName: job?.name, jobId: job?.id, err }, 'Job failed');
    });

    workers.push(worker);
    log.info({ queue: queueName, concurrency, handlers: handlers.map((h) => h.jobName) }, 'Started worker');
  }

  // ── Schedule daily data retention cleanup ───────────────────────────
  const deferredQueue = getQueue(QUEUE_NAMES.DEFERRED);
  await deferredQueue.add(
    'platform.data.retention',
    { policies: [...DEFAULT_RETENTION_POLICIES, ...modules.flatMap(m => m.retentionPolicies ?? [])] },
    { repeat: { every: 86_400_000 }, jobId: 'daily-retention' },
  );

  // ── Schedule correlation expiry sweep every 5 minutes ───────────────
  await deferredQueue.add(
    'correlation.expiry',
    {},
    { repeat: { every: 300_000 }, jobId: 'correlation-expiry-sweep' },
  );

  // ── Schedule RPC usage flush every 5 minutes ────────────────────────
  const moduleJobsQueue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await moduleJobsQueue.add(
    'chain.rpc-usage.flush',
    {},
    { repeat: { every: 300_000 }, jobId: 'rpc-usage-flush' },
  );

  // ── Graceful shutdown ───────────────────────────────────────────────
  async function shutdown(signal: string) {
    log.info({ signal }, 'Shutting down');
    await Promise.allSettled(workers.map((w) => w.close()));
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
