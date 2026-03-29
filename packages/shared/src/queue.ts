import { Queue, Worker, FlowProducer, type Processor, type WorkerOptions, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { jobDuration } from './metrics.js';

// ---------------------------------------------------------------------------
// Queue names — single source of truth
// ---------------------------------------------------------------------------

export const QUEUE_NAMES = {
  EVENTS: 'events',           // normalized events → rule evaluation
  ALERTS: 'alerts',           // alert candidates → notification dispatch
  MODULE_JOBS: 'module-jobs', // module-specific work (webhook processing, polling, etc.)
  DEFERRED: 'deferred',       // deferred rule evaluation (grace period pattern)
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// Shared Redis connection
// ---------------------------------------------------------------------------

let _connection: Redis | undefined;

export function setSharedConnection(redis: Redis): void {
  _connection = redis;
}

function getConnection(): Redis {
  if (!_connection) {
    throw new Error('Shared Redis connection not initialised. Call setSharedConnection() first.');
  }
  return _connection;
}

// ---------------------------------------------------------------------------
// Queue factory
// ---------------------------------------------------------------------------

// Stores resolved Queue instances.
const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  // `new Queue()` is synchronous — no async gap means no TOCTOU race.
  // The return value is taken directly from the local variable, never from
  // a `.get()` that could return undefined.
  const queue = new Queue(name, {
    connection: getConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  });

  queues.set(name, queue);
  return queue;
}

// ---------------------------------------------------------------------------
// Job handler interface
// ---------------------------------------------------------------------------

export interface JobHandler {
  /** Job name — used as queue.add(jobName, data) */
  readonly jobName: string;

  /** Which queue this handler listens on */
  readonly queueName: string;

  /** Process the job */
  process(job: Job): Promise<void>;
}

// ---------------------------------------------------------------------------
// Connection factory type
// ---------------------------------------------------------------------------

/**
 * A function that creates a new Redis connection.
 * Used by createWorker to give each Worker its own connection, as
 * recommended by BullMQ to avoid head-of-line blocking between workers.
 */
export type RedisConnectionFactory = () => Redis;

let _connectionFactory: RedisConnectionFactory | undefined;

/**
 * Register a connection factory so each Worker gets its own Redis connection.
 * If not set, workers fall back to the shared connection (legacy behaviour).
 */
export function setConnectionFactory(factory: RedisConnectionFactory): void {
  _connectionFactory = factory;
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

// Track all created Workers so closeAllQueues() can close them and release
// their Redis connections on graceful shutdown.
const workers = new Set<Worker>();

export function createWorker(
  queueName: string,
  handlers: JobHandler[],
  opts: Partial<WorkerOptions> = {},
): Worker {
  const handlerMap = new Map<string, JobHandler>();
  for (const h of handlers) {
    handlerMap.set(h.jobName, h);
  }

  const processor: Processor = async (job) => {
    const handler = handlerMap.get(job.name);
    if (!handler) throw new Error(`No handler for job "${job.name}" on queue "${queueName}"`);

    const start = performance.now();
    try {
      return await handler.process(job);
    } finally {
      const durationSec = (performance.now() - start) / 1000;
      jobDuration.observe({ queue: queueName, jobName: job.name }, durationSec);
    }
  };

  // Each Worker gets its own dedicated Redis connection when a factory is
  // available. BullMQ recommends separate connections for Worker vs Queue to
  // avoid head-of-line blocking on the blocking BRPOPLPUSH that workers use.
  const connection = _connectionFactory ? _connectionFactory() : getConnection();

  const worker = new Worker(queueName, processor, {
    connection,
    concurrency: 5,
    ...opts,
  });

  workers.add(worker);
  return worker;
}

// ---------------------------------------------------------------------------
// FlowProducer (for fan-out/fan-in pipelines)
// ---------------------------------------------------------------------------

let _flowProducer: FlowProducer | undefined;

export function getFlowProducer(): FlowProducer {
  if (!_flowProducer) {
    _flowProducer = new FlowProducer({ connection: getConnection() });
  }
  return _flowProducer;
}

// ---------------------------------------------------------------------------
// Graceful close
// ---------------------------------------------------------------------------

export async function closeAllQueues(): Promise<void> {
  const closables: Array<Promise<unknown>> = [
    ...[...queues.values()].map((q) => q.close()),
    // Close tracked Workers so they release their Redis connections.
    // Previously Workers were untracked and left open on shutdown.
    ...[...workers].map((w) => w.close()),
  ];
  if (_flowProducer) {
    closables.push(_flowProducer.close());
    _flowProducer = undefined;
  }
  await Promise.allSettled(closables);
  queues.clear();
  workers.clear();
  if (_connection && typeof _connection.quit === 'function') {
    await _connection.quit();
    _connection = undefined;
  }
}
