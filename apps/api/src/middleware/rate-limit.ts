/**
 * Redis-backed rate limiting for Hono.
 * Ported from Verity's rate-limit.ts (express-rate-limit + RedisStore).
 *
 * Key generation priority: userId > apiKey prefix > IP address
 * IP derivation is delegated to @sentinel/shared/ip (getClientIp) which
 * applies TRUSTED_PROXY_COUNT rules to avoid header-injection spoofing.
 */
import type { Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthContext } from '@sentinel/shared/hono-types';
import { getClientIp } from '@sentinel/shared/ip';
import { env } from '@sentinel/shared/env';
import { getSharedRedis } from '../redis.js';

function getKey(c: AuthContext): string {
  const userId = c.get('userId');
  if (userId) return `user:${userId}`;

  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer sk_')) return `key:${auth.slice(7, 27)}`;

  return `ip:${getClientIp(c)}`;
}

interface RateLimitOptions {
  windowMs: number;
  limit: number;
  prefix: string;
  slidingWindow?: boolean;
}

// Fixed-window Lua: INCR + EXPIRE in one round-trip.
const FIXED_WINDOW_LUA = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  local ttl = redis.call('TTL', KEYS[1])
  return {current, ttl}
`;

// Sliding-window Lua: ZSET with timestamp scores. Removes entries older than
// the window, adds the current request, and returns the count. Prevents the
// 2x burst at fixed-window boundaries.
const SLIDING_WINDOW_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local windowSec = tonumber(ARGV[3])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('EXPIRE', key, windowSec)
  local count = redis.call('ZCARD', key)
  return count
`;

function createLimiter(opts: RateLimitOptions) {
  return async (c: AuthContext, next: Next) => {
    const config = env();
    if (config.DISABLE_RATE_LIMIT === 'true' && config.NODE_ENV !== 'production') return next();

    const redis = getSharedRedis();
    const key = `sentinel:rl:${opts.prefix}:${getKey(c)}`;
    const windowSec = Math.ceil(opts.windowMs / 1000);

    let current: number;
    let resetEpoch: number;

    if (opts.slidingWindow) {
      const now = Date.now();
      current = await redis.eval(SLIDING_WINDOW_LUA, 1, key, now, opts.windowMs, windowSec) as number;
      resetEpoch = Math.ceil(now / 1000) + windowSec;
    } else {
      const result = await redis.eval(FIXED_WINDOW_LUA, 1, key, windowSec) as [number, number];
      current = result[0];
      const ttl = result[1];
      resetEpoch = Math.ceil(Date.now() / 1000) + (ttl > 0 ? ttl : windowSec);
    }

    // Set standard rate limit headers
    const remaining = Math.max(0, opts.limit - current);

    c.header('X-RateLimit-Limit', String(opts.limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(resetEpoch));

    if (current > opts.limit) {
      throw new HTTPException(429, { message: 'Too many requests, please try again later' });
    }

    await next();
  };
}

/** 10 attempts per 15 minutes — for login/register */
export const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  prefix: 'auth',
  slidingWindow: true,
});

/** 100 requests per minute — for read endpoints */
export const apiReadLimiter = createLimiter({
  windowMs: 60_000,
  limit: 100,
  prefix: 'read',
});

/** 30 requests per minute — for write endpoints */
export const apiWriteLimiter = createLimiter({
  windowMs: 60_000,
  limit: 30,
  prefix: 'write',
});
