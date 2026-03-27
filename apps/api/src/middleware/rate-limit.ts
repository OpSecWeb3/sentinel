/**
 * Redis-backed rate limiting for Hono.
 * Ported from Verity's rate-limit.ts (express-rate-limit + RedisStore).
 *
 * Key generation priority: orgId > apiKey prefix > IP address
 * IP derivation is delegated to @sentinel/shared/ip (getClientIp) which
 * applies TRUSTED_PROXY_COUNT rules to avoid header-injection spoofing.
 */
import type { Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthContext } from '@sentinel/shared/hono-types';
import { getClientIp } from '@sentinel/shared/ip';
import IORedis from 'ioredis';

let _redis: IORedis | undefined;

function getRedis(): IORedis {
  if (!_redis) {
    _redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return _redis;
}

function getKey(c: AuthContext): string {
  const orgId = c.get('orgId');
  if (orgId) return `org:${orgId}`;

  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer sk_')) return `key:${auth.slice(7, 18)}`;

  return `ip:${getClientIp(c)}`;
}

interface RateLimitOptions {
  windowMs: number;
  limit: number;
  prefix: string;
}

function createLimiter(opts: RateLimitOptions) {
  return async (c: AuthContext, next: Next) => {
    if (process.env.DISABLE_RATE_LIMIT === 'true') return next();

    const redis = getRedis();
    const key = `sentinel:rl:${opts.prefix}:${getKey(c)}`;
    const windowSec = Math.ceil(opts.windowMs / 1000);

    // Use a Lua script to atomically INCR and set EXPIRE to avoid
    // race conditions where a crash between INCR and EXPIRE leaves
    // a key without a TTL.
    const luaScript = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return current
    `;
    const current = await redis.eval(luaScript, 1, key, windowSec) as number;

    // Set standard rate limit headers
    const ttl = await redis.ttl(key);
    const remaining = Math.max(0, opts.limit - current);
    const reset = Math.ceil(Date.now() / 1000) + (ttl > 0 ? ttl : windowSec);

    c.header('X-RateLimit-Limit', String(opts.limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(reset));

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
