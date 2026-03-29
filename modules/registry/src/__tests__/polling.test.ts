/**
 * Unit tests for the registry polling module.
 *
 * Focuses on the distributed full-scan lock that prevents multiple workers
 * from simultaneously executing a full scan for the same artifact.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as queueModule from '@sentinel/shared/queue';
import { tryClaimFullScanLock, resetFullScanTracking } from '../polling.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedisMock(setResult: 'OK' | null = 'OK') {
  return {
    set: vi.fn().mockResolvedValue(setResult),
  } as any;
}

// ---------------------------------------------------------------------------
// tryClaimFullScanLock
// ---------------------------------------------------------------------------

describe('tryClaimFullScanLock', () => {
  let getSharedRedisSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetFullScanTracking();
    getSharedRedisSpy = vi.spyOn(queueModule, 'getSharedRedis');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true and acquires the lock when Redis grants SET NX', async () => {
    const redis = makeRedisMock('OK');
    getSharedRedisSpy.mockReturnValue(redis);

    const result = await tryClaimFullScanLock('artifact-1');

    expect(result).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      'registry:fullscan:artifact-1',
      '1',
      'EX',
      300,
      'NX',
    );
  });

  it('returns false when the lock is already held (SET NX returns null)', async () => {
    const redis = makeRedisMock(null);
    getSharedRedisSpy.mockReturnValue(redis);

    const result = await tryClaimFullScanLock('artifact-2');

    expect(result).toBe(false);
  });

  it('returns true (graceful fallback) when Redis is not initialised', async () => {
    getSharedRedisSpy.mockReturnValue(undefined);

    const result = await tryClaimFullScanLock('artifact-3');

    expect(result).toBe(true);
  });

  it('returns true (graceful fallback) when Redis throws an error', async () => {
    const redis = {
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as import('ioredis').Redis;
    getSharedRedisSpy.mockReturnValue(redis);

    const result = await tryClaimFullScanLock('artifact-4');

    expect(result).toBe(true);
  });

  it('uses distinct Redis keys for different artifact IDs', async () => {
    const redis = makeRedisMock('OK');
    getSharedRedisSpy.mockReturnValue(redis);

    await tryClaimFullScanLock('art-aaa');
    await tryClaimFullScanLock('art-bbb');

    const keys = redis.set.mock.calls.map((c: unknown[]) => c[0]);
    expect(keys).toContain('registry:fullscan:art-aaa');
    expect(keys).toContain('registry:fullscan:art-bbb');
    expect(new Set(keys).size).toBe(2);
  });

  it('simulates two concurrent workers — only the first acquires the lock', async () => {
    // First call returns OK (lock acquired), second returns null (lock held).
    const redis = {
      set: vi
        .fn()
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce(null),
    } as any;
    getSharedRedisSpy.mockReturnValue(redis);

    const [workerA, workerB] = await Promise.all([
      tryClaimFullScanLock('shared-artifact'),
      tryClaimFullScanLock('shared-artifact'),
    ]);

    const results = [workerA, workerB];
    expect(results.filter(Boolean).length).toBe(1);  // exactly one winner
    expect(results.filter((r) => !r).length).toBe(1); // exactly one loser
  });
});
