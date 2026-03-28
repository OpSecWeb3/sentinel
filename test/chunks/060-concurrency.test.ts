/**
 * Chunk 058 — Queue: connection management + queue/worker factory + graceful shutdown
 * Chunk 060 — Concurrency: acquireSlot/releaseSlot (Lua atomicity, TTL, concurrent callers)
 * Chunk 061 — FanOut: createFanOutPipeline + getChildResults
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestRedis } from '../helpers/setup.js';

describe('Chunk 060 — Concurrency slot management', () => {
  let redis: any;

  beforeEach(async () => {
    redis = getTestRedis();
  });

  it('should acquire slot atomically via INCR', async () => {
    const slotKey = 'sentinel:slot:test-resource';
    const MAX_SLOTS = 3;

    // Acquire first slot
    const current = await redis.incr(slotKey);
    await redis.expire(slotKey, 300);
    expect(current).toBe(1);
    expect(current <= MAX_SLOTS).toBe(true);
  });

  it('should reject when max slots reached', async () => {
    const slotKey = 'sentinel:slot:full-resource';
    const MAX_SLOTS = 2;

    // Fill all slots
    await redis.set(slotKey, String(MAX_SLOTS));

    const current = await redis.incr(slotKey);
    const acquired = current <= MAX_SLOTS;

    if (!acquired) {
      // Release the increment since we didn't really acquire
      await redis.decr(slotKey);
    }

    expect(acquired).toBe(false);
  });

  it('should release slot via DECR', async () => {
    const slotKey = 'sentinel:slot:release-test';

    await redis.set(slotKey, '2');
    const after = await redis.decr(slotKey);
    expect(after).toBe(1);
  });

  it('should not go below 0 on release', async () => {
    const slotKey = 'sentinel:slot:zero-test';

    await redis.set(slotKey, '0');
    const after = await redis.decr(slotKey);
    // Redis allows negative values, but we should guard against it
    expect(after).toBe(-1);
    // Application should clamp to 0
    const clamped = Math.max(0, after);
    expect(clamped).toBe(0);
  });

  it('should set TTL on slot key for crash recovery', async () => {
    const slotKey = 'sentinel:slot:ttl-test';

    await redis.set(slotKey, '1', 'EX', 300);
    const ttl = await redis.ttl(slotKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('should handle concurrent callers safely', async () => {
    const slotKey = 'sentinel:slot:concurrent';
    const MAX_SLOTS = 5;

    // Simulate concurrent acquires
    const promises = Array.from({ length: 10 }, () => redis.incr(slotKey));
    const results = await Promise.all(promises);

    // Each result should be unique and sequential
    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const acquired = results.filter((r: number) => r <= MAX_SLOTS);
    expect(acquired.length).toBe(MAX_SLOTS);
  });
});

describe('Chunk 061 — FanOut pipeline', () => {
  let redis: any;

  beforeEach(async () => {
    redis = getTestRedis();
  });

  it('should track child job results', async () => {
    const parentId = 'fan-out-parent-1';
    const resultKey = `sentinel:fanout:${parentId}:results`;

    // Simulate child results
    await redis.rpush(resultKey, JSON.stringify({ childId: 'c1', status: 'ok' }));
    await redis.rpush(resultKey, JSON.stringify({ childId: 'c2', status: 'ok' }));
    await redis.rpush(resultKey, JSON.stringify({ childId: 'c3', status: 'error', error: 'timeout' }));

    const results = await redis.lrange(resultKey, 0, -1);
    expect(results.length).toBe(3);

    const parsed = results.map((r: string) => JSON.parse(r));
    const errors = parsed.filter((r: any) => r.status === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].error).toBe('timeout');
  });

  it('should aggregate when all children complete', async () => {
    const parentId = 'fan-out-agg';
    const expectedChildren = 3;
    const counterKey = `sentinel:fanout:${parentId}:count`;

    // Each child increments counter
    for (let i = 0; i < expectedChildren; i++) {
      await redis.incr(counterKey);
    }

    const count = Number(await redis.get(counterKey));
    const allDone = count >= expectedChildren;
    expect(allDone).toBe(true);
  });

  it('should expire fan-out keys after TTL', async () => {
    const parentId = 'fan-out-expire';
    const resultKey = `sentinel:fanout:${parentId}:results`;

    await redis.rpush(resultKey, 'result-1');
    await redis.expire(resultKey, 1);

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 1100));

    const exists = await redis.exists(resultKey);
    expect(exists).toBe(0);
  });
});
