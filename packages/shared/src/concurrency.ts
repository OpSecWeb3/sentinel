/**
 * Redis-based concurrency limiting.
 * Ported from Scout's concurrency service.
 *
 * Uses Lua scripts for atomic INCR + PEXPIRE / DECR + floor-at-zero
 * to prevent keys without TTLs (crash between INCR and PEXPIRE) and
 * negative counter drift.
 */
import type { Redis } from 'ioredis';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min safety TTL

/**
 * Lua script: atomically INCR the key, set PEXPIRE on first acquisition,
 * and DECR back if the limit is exceeded. Returns the post-INCR value
 * (0 means limit was exceeded and the increment was rolled back).
 *
 * KEYS[1] = concurrency key
 * ARGV[1] = maxConcurrent
 * ARGV[2] = ttlMs
 *
 * Returns: current count after INCR, or 0 if over limit (decremented back).
 */
const ACQUIRE_LUA = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  if current > tonumber(ARGV[1]) then
    redis.call('DECR', KEYS[1])
    return 0
  end
  return current
`;

/**
 * Lua script: atomically DECR the key and floor at 0.
 *
 * KEYS[1] = concurrency key
 * Returns: the value after decrement (floored at 0).
 */
const RELEASE_LUA = `
  local val = redis.call('DECR', KEYS[1])
  if val < 0 then
    redis.call('SET', KEYS[1], '0')
    return 0
  end
  return val
`;

/**
 * Try to acquire a concurrency slot.
 * Returns true if slot acquired, false if limit reached.
 */
export async function acquireSlot(
  redis: Redis,
  key: string,
  maxConcurrent: number,
  ttlMs = DEFAULT_TTL_MS,
): Promise<boolean> {
  const result = await redis.eval(ACQUIRE_LUA, 1, key, maxConcurrent, ttlMs) as number;
  return result > 0;
}

/**
 * Release a concurrency slot.
 */
export async function releaseSlot(redis: Redis, key: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, key) as number;
}
