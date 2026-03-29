import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock queue module before importing escalation
vi.mock('../queue.js', () => {
  const mockAdd = vi.fn().mockResolvedValue({ id: 'job-123' });
  return {
    QUEUE_NAMES: {
      EVENTS: 'events',
      ALERTS: 'alerts',
      MODULE_JOBS: 'module-jobs',
      DEFERRED: 'deferred',
    },
    getQueue: vi.fn(() => ({ add: mockAdd })),
    _mockAdd: mockAdd,
  };
});

import { escalate, ESCALATION_PRIORITIES } from '../escalation.js';
import { getQueue, QUEUE_NAMES } from '../queue.js';

const mockAdd = (await import('../queue.js') as any)._mockAdd;

describe('escalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues to MODULE_JOBS with emergency priority by default', async () => {
    const id = await escalate('scan:deep', { targetId: 'abc' });

    expect(getQueue).toHaveBeenCalledWith(QUEUE_NAMES.MODULE_JOBS);
    expect(mockAdd).toHaveBeenCalledWith('scan:deep', { targetId: 'abc' }, {
      priority: ESCALATION_PRIORITIES.emergency,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
    expect(id).toBe('job-123');
  });

  it('accepts custom queue, priority, attempts, and backoff', async () => {
    await escalate('rescan', { host: 'x' }, {
      queueName: 'alerts',
      priority: ESCALATION_PRIORITIES.elevated,
      attempts: 5,
      backoff: { type: 'fixed', delay: 500 },
    });

    expect(getQueue).toHaveBeenCalledWith('alerts');
    expect(mockAdd).toHaveBeenCalledWith('rescan', { host: 'x' }, {
      priority: 3,
      attempts: 5,
      backoff: { type: 'fixed', delay: 500 },
    });
  });

  it('ESCALATION_PRIORITIES has expected values', () => {
    expect(ESCALATION_PRIORITIES.emergency).toBe(1);
    expect(ESCALATION_PRIORITIES.elevated).toBe(3);
    expect(ESCALATION_PRIORITIES.normal).toBe(5);
  });

  it('returns undefined when job.id is undefined', async () => {
    mockAdd.mockResolvedValueOnce({ id: undefined });
    const id = await escalate('noop', {});
    expect(id).toBeUndefined();
  });
});
