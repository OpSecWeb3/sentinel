/**
 * Fan-out/fan-in pipeline coordination using BullMQ FlowProducer.
 *
 * Creates parent-child job trees where:
 *   - Child jobs execute in parallel on their respective queues
 *   - The parent (aggregation) job auto-activates when all children complete
 *   - Child return values are available in the parent via getChildResults()
 */
import type { Job } from 'bullmq';
import { getFlowProducer } from './queue.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for a fan-out child job. */
export interface FanOutChild {
  /** Job name — must match a registered JobHandler.jobName */
  jobName: string;
  /** Queue name — must match the handler's queueName */
  queueName: string;
  /** Job payload data */
  data: Record<string, unknown>;
  /** Optional job options */
  opts?: {
    priority?: number;
    delay?: number;
    attempts?: number;
  };
}

/** Options for creating a fan-out pipeline. */
export interface FanOutOptions {
  /** Job name for the aggregation (parent) handler */
  parentJobName: string;
  /** Queue for the aggregation handler */
  parentQueueName: string;
  /** Data passed to the parent job alongside child results */
  parentData?: Record<string, unknown>;
  /** Child jobs to fan out */
  children: FanOutChild[];
}

/** Aggregated results from completed child jobs. */
export interface FanInResult<T = unknown> {
  /** Map of child job key (format: "queueName:jobId") → return value */
  childResults: Record<string, T>;
  /** Number of children that completed and returned values */
  successCount: number;
}

// ---------------------------------------------------------------------------
// Pipeline creation
// ---------------------------------------------------------------------------

/**
 * Create a fan-out pipeline: enqueue N child jobs and a parent job that
 * auto-activates when all children complete.
 *
 * @returns The parent job's ID
 */
export async function createFanOutPipeline(opts: FanOutOptions): Promise<string> {
  if (opts.children.length === 0) {
    throw new Error('Fan-out pipeline requires at least one child job');
  }

  const flow = getFlowProducer();

  const tree = await flow.add({
    name: opts.parentJobName,
    queueName: opts.parentQueueName,
    data: opts.parentData ?? {},
    children: opts.children.map((child) => ({
      name: child.jobName,
      queueName: child.queueName,
      data: child.data,
      opts: {
        ...child.opts,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    })),
  });

  return tree.job.id!;
}

// ---------------------------------------------------------------------------
// Result extraction (used inside aggregation handlers)
// ---------------------------------------------------------------------------

/**
 * Extract child job results inside an aggregation handler's `process()`.
 *
 * Call this from the parent job handler to get all completed child values.
 * Each child handler must `return` a value from its `process()` for it to
 * appear here (void returns are excluded).
 */
export async function getChildResults<T = unknown>(
  job: Job,
): Promise<FanInResult<T>> {
  const values = (await job.getChildrenValues()) as Record<string, T>;
  const entries = Object.entries(values);

  return {
    childResults: values,
    successCount: entries.length,
  };
}
