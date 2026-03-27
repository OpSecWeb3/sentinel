import { Queue, Worker, FlowProducer, type Processor, type WorkerOptions, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

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

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  if (!queues.has(name)) {
    queues.set(
      name,
      new Queue(name, {
        connection: getConnection(),
        defaultJobOptions: {
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      }),
    );
  }
  return queues.get(name)!;
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
// Worker factory
// ---------------------------------------------------------------------------

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
    await handler.process(job);
  };

  return new Worker(queueName, processor, {
    connection: getConnection(),
    concurrency: 5,
    ...opts,
  });
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
    ...([...queues.values()].map((q) => q.close())),
  ];
  if (_flowProducer) {
    closables.push(_flowProducer.close());
    _flowProducer = undefined;
  }
  await Promise.allSettled(closables);
  queues.clear();
}
