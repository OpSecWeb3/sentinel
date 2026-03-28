/**
 * Shared Redis connection for the API process.
 *
 * A single IORedis instance is created during startup (index.ts calls
 * setSharedRedis) and reused by every consumer (rate-limiter, health check,
 * etc.) so the process maintains exactly one connection to Redis.
 */
import type IORedis from 'ioredis';

let _redis: IORedis | undefined;

export function setSharedRedis(redis: IORedis): void {
  _redis = redis;
}

export function getSharedRedis(): IORedis {
  if (!_redis) {
    throw new Error('Shared Redis connection not initialised. Call setSharedRedis() before using getSharedRedis().');
  }
  return _redis;
}
