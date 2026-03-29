import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock queue module
vi.mock('../queue.js', () => {
  const mockFlowAdd = vi.fn().mockResolvedValue({ job: { id: 'parent-1' } });
  return {
    getFlowProducer: vi.fn(() => ({ add: mockFlowAdd })),
    _mockFlowAdd: mockFlowAdd,
  };
});

import { createFanOutPipeline, getChildResults, type FanOutOptions } from '../fan-out.js';

const mockFlowAdd = (await import('../queue.js') as any)._mockFlowAdd;

describe('createFanOutPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when children array is empty', async () => {
    await expect(
      createFanOutPipeline({ parentJobName: 'agg', parentQueueName: 'q', children: [] }),
    ).rejects.toThrow('at least one child job');
  });

  it('creates flow with parent and children', async () => {
    const opts: FanOutOptions = {
      parentJobName: 'aggregate',
      parentQueueName: 'module-jobs',
      parentData: { scanId: '1' },
      children: [
        { jobName: 'scan:dns', queueName: 'module-jobs', data: { host: 'a.com' } },
        { jobName: 'scan:tls', queueName: 'module-jobs', data: { host: 'a.com' }, opts: { priority: 2 } },
      ],
    };

    const id = await createFanOutPipeline(opts);
    expect(id).toBe('parent-1');

    expect(mockFlowAdd).toHaveBeenCalledWith({
      name: 'aggregate',
      queueName: 'module-jobs',
      data: { scanId: '1' },
      children: [
        {
          name: 'scan:dns',
          queueName: 'module-jobs',
          data: { host: 'a.com' },
          opts: { removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } },
        },
        {
          name: 'scan:tls',
          queueName: 'module-jobs',
          data: { host: 'a.com' },
          opts: { priority: 2, removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } },
        },
      ],
    });
  });

  it('defaults parentData to empty object', async () => {
    await createFanOutPipeline({
      parentJobName: 'agg',
      parentQueueName: 'q',
      children: [{ jobName: 'j', queueName: 'q', data: {} }],
    });

    expect(mockFlowAdd.mock.calls[0][0].data).toEqual({});
  });
});

describe('getChildResults', () => {
  it('extracts child values from a job', async () => {
    const fakeJob = {
      getChildrenValues: vi.fn().mockResolvedValue({
        'module-jobs:child-1': { ok: true },
        'module-jobs:child-2': { ok: false },
      }),
    } as any;

    const result = await getChildResults(fakeJob);
    expect(result.successCount).toBe(2);
    expect(result.childResults).toEqual({
      'module-jobs:child-1': { ok: true },
      'module-jobs:child-2': { ok: false },
    });
  });

  it('returns zero count when no children completed', async () => {
    const fakeJob = { getChildrenValues: vi.fn().mockResolvedValue({}) } as any;
    const result = await getChildResults(fakeJob);
    expect(result.successCount).toBe(0);
    expect(result.childResults).toEqual({});
  });
});
