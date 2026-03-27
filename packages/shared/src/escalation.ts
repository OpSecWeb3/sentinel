import { getQueue, QUEUE_NAMES } from './queue.js';

export interface EscalationOptions {
  /** Queue name. Defaults to MODULE_JOBS. */
  queueName?: string;
  /** BullMQ job priority (lower = higher). Defaults to emergency (1). */
  priority?: number;
  /** Max retry attempts. Defaults to 3. */
  attempts?: number;
  /** Backoff config. Defaults to exponential with 2s delay. */
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
}

/** Standard priority levels for escalation jobs. */
export const ESCALATION_PRIORITIES = {
  emergency: 1,
  elevated: 3,
  normal: 5,
} as const;

/**
 * Enqueue an emergency/escalation job with elevated priority.
 * Platform pattern for "probe detects issue -> enqueue deeper scan".
 */
export async function escalate(
  jobName: string,
  data: Record<string, unknown>,
  options: EscalationOptions = {},
): Promise<string | undefined> {
  const {
    queueName = QUEUE_NAMES.MODULE_JOBS,
    priority = ESCALATION_PRIORITIES.emergency,
    attempts = 3,
    backoff = { type: 'exponential', delay: 2000 },
  } = options;

  const queue = getQueue(queueName);
  const job = await queue.add(jobName, data, { priority, attempts, backoff });
  return job.id;
}
