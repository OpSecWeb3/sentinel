import { describe, it, expect, beforeEach } from 'vitest';
import { acquireSlot, releaseSlot } from '../concurrency.js';

// ---------------------------------------------------------------------------
// Minimal Redis mock backed by a Map.
// Implements `eval` to match the Lua-script-based acquireSlot / releaseSlot.
// ---------------------------------------------------------------------------
function createRedisMock() {
  const store = new Map<string, number>();

  return {
    _store: store,

    /**
     * Simulates `redis.eval(script, 1, key, ...args)`.
     * We detect which Lua script is being run by inspecting the script text
     * and replicate its semantics in JS so the unit tests stay deterministic.
     */
    async eval(script: string, _numKeys: number, key: string, ...args: unknown[]): Promise<number> {
      if (script.includes('INCR')) {
        // ACQUIRE script: INCR, conditional PEXPIRE, check limit, DECR if over
        const current = (store.get(key) ?? 0) + 1;
        store.set(key, current);
        const maxConcurrent = Number(args[0]);
        if (current > maxConcurrent) {
          store.set(key, current - 1);
          return 0;
        }
        return current;
      }
      // RELEASE script: DECR, floor at 0
      const val = (store.get(key) ?? 0) - 1;
      if (val < 0) {
        store.set(key, 0);
        return 0;
      }
      store.set(key, val);
      return val;
    },
  } as any; // cast to Redis interface — only the methods we use
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('concurrency - acquireSlot / releaseSlot', () => {
  let redis: ReturnType<typeof createRedisMock>;
  const KEY = 'test:concurrency';
  const MAX = 3;

  beforeEach(() => {
    redis = createRedisMock();
  });

  it('acquireSlot succeeds when under limit', async () => {
    expect(await acquireSlot(redis, KEY, MAX)).toBe(true);
    expect(redis._store.get(KEY)).toBe(1);
  });

  it('acquireSlot succeeds up to the limit', async () => {
    expect(await acquireSlot(redis, KEY, MAX)).toBe(true);
    expect(await acquireSlot(redis, KEY, MAX)).toBe(true);
    expect(await acquireSlot(redis, KEY, MAX)).toBe(true);
    expect(redis._store.get(KEY)).toBe(3);
  });

  it('acquireSlot fails when at limit', async () => {
    await acquireSlot(redis, KEY, MAX);
    await acquireSlot(redis, KEY, MAX);
    await acquireSlot(redis, KEY, MAX);

    // This one should be rejected and counter rolled back
    expect(await acquireSlot(redis, KEY, MAX)).toBe(false);
    // Counter should be back to 3 (incr to 4, then decr back)
    expect(redis._store.get(KEY)).toBe(3);
  });

  it('acquireSlot fails repeatedly when at limit', async () => {
    for (let i = 0; i < MAX; i++) await acquireSlot(redis, KEY, MAX);

    expect(await acquireSlot(redis, KEY, MAX)).toBe(false);
    expect(await acquireSlot(redis, KEY, MAX)).toBe(false);
    // Counter should stay at 3 (each attempt incr+decr)
    expect(redis._store.get(KEY)).toBe(3);
  });

  it('releaseSlot allows new acquisitions', async () => {
    for (let i = 0; i < MAX; i++) await acquireSlot(redis, KEY, MAX);
    expect(await acquireSlot(redis, KEY, MAX)).toBe(false);

    await releaseSlot(redis, KEY);
    expect(redis._store.get(KEY)).toBe(2);

    // Now we should be able to acquire again
    expect(await acquireSlot(redis, KEY, MAX)).toBe(true);
    expect(redis._store.get(KEY)).toBe(3);
  });

  it('releaseSlot multiple times frees multiple slots', async () => {
    for (let i = 0; i < MAX; i++) await acquireSlot(redis, KEY, MAX);

    await releaseSlot(redis, KEY);
    await releaseSlot(redis, KEY);
    expect(redis._store.get(KEY)).toBe(1);

    expect(await acquireSlot(redis, KEY, MAX)).toBe(true);
    expect(await acquireSlot(redis, KEY, MAX)).toBe(true);
    expect(redis._store.get(KEY)).toBe(3);
  });

  it('counter does not go negative on extra releases', async () => {
    // Release without prior acquire
    await releaseSlot(redis, KEY);
    // The code sets to 0 if val < 0
    expect(redis._store.get(KEY)).toBe(0);
  });

  it('counter resets to zero on double extra release', async () => {
    await acquireSlot(redis, KEY, MAX);
    await releaseSlot(redis, KEY); // back to 0
    await releaseSlot(redis, KEY); // would go -1, reset to 0
    expect(redis._store.get(KEY)).toBe(0);
  });

  it('maxConcurrent of 1 allows only one slot', async () => {
    expect(await acquireSlot(redis, KEY, 1)).toBe(true);
    expect(await acquireSlot(redis, KEY, 1)).toBe(false);
    await releaseSlot(redis, KEY);
    expect(await acquireSlot(redis, KEY, 1)).toBe(true);
  });
});
