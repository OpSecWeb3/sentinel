/**
 * VirusTotal passive subdomain discovery.
 *
 * Fetches subdomains from VT v3 `GET /domains/{domain}/subdomains`.
 * Uses a Redis sliding-window rate limiter (4 requests per 60s) to
 * stay within VT free-tier limits. Pagination is capped at 10 pages
 * (200 subdomains). All failures are non-fatal — returns partial results.
 */
import type { Redis } from 'ioredis';

import { env } from '@sentinel/shared/env';
import { logger as rootLogger } from '@sentinel/shared/logger';

const log = rootLogger.child({ component: 'infra-vt-subdomains' });

const VT_API_BASE = 'https://www.virustotal.com/api/v3';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const MAX_SUBDOMAINS = 200;

// Sliding-window rate limiter: 4 requests per 60 seconds
const VT_RATE_LIMIT_KEY = 'sentinel:vt:ratelimit';
const VT_RATE_LIMIT_WINDOW_MS = 60_000;
const VT_RATE_LIMIT_MAX = 4;

// Lua script: sliding-window rate limiter using a sorted set.
// Returns 1 if allowed, 0 if rejected.
const SLIDING_WINDOW_CHECK_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local maxRequests = tonumber(ARGV[3])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
  local count = redis.call('ZCARD', key)
  if count >= maxRequests then
    return 0
  end
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('EXPIRE', key, math.ceil(windowMs / 1000))
  return 1
`;

export interface VtSubdomainResult {
  subdomains: string[];
  pagesFetched: number;
  rateLimited: boolean;
}

/**
 * Check if a request is allowed under the sliding-window rate limit.
 * Returns true if allowed, false if the rate limit would be exceeded.
 */
async function acquireVtRateSlot(redis: Redis): Promise<boolean> {
  const now = Date.now();
  const result = await redis.eval(
    SLIDING_WINDOW_CHECK_LUA,
    1,
    VT_RATE_LIMIT_KEY,
    now,
    VT_RATE_LIMIT_WINDOW_MS,
    VT_RATE_LIMIT_MAX,
  ) as number;
  return result === 1;
}

/**
 * Fetch subdomains from VirusTotal passive DNS for the given domain.
 *
 * - Returns empty immediately if no API key is configured.
 * - Uses Redis sliding-window rate limiter when Redis is available.
 * - Paginates up to MAX_PAGES / MAX_SUBDOMAINS.
 * - Fail-open: on 429, timeout, or network error returns partial results.
 */
export async function fetchVtSubdomains(
  domain: string,
  opts: { redis?: Redis },
): Promise<VtSubdomainResult> {
  const apiKey = env().VIRUSTOTAL_API_KEY;
  if (!apiKey) {
    return { subdomains: [], pagesFetched: 0, rateLimited: false };
  }

  const subdomains: string[] = [];
  let pagesFetched = 0;
  let rateLimited = false;
  let nextUrl: string | null = `${VT_API_BASE}/domains/${encodeURIComponent(domain)}/subdomains?limit=20`;

  while (nextUrl && pagesFetched < MAX_PAGES && subdomains.length < MAX_SUBDOMAINS) {
    // Check rate limit if Redis is available
    if (opts.redis) {
      const allowed = await acquireVtRateSlot(opts.redis);
      if (!allowed) {
        log.info({ domain, pagesFetched }, 'VT rate limit reached, returning partial results');
        rateLimited = true;
        break;
      }
    }

    try {
      const response = await fetch(nextUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'x-apikey': apiKey,
          'Accept': 'application/json',
        },
      });

      if (response.status === 429) {
        log.info({ domain, pagesFetched }, 'VT returned 429, returning partial results');
        rateLimited = true;
        break;
      }

      if (!response.ok) {
        log.warn({ domain, status: response.status }, 'VT API returned non-OK status');
        break;
      }

      const data = (await response.json()) as {
        data?: Array<{ id?: string }>;
        links?: { next?: string };
      };

      if (data.data) {
        for (const item of data.data) {
          if (item.id && subdomains.length < MAX_SUBDOMAINS) {
            subdomains.push(item.id);
          }
        }
      }

      pagesFetched++;
      nextUrl = data.links?.next ?? null;
    } catch (err) {
      // Network error or timeout — return what we have
      log.warn({ domain, err, pagesFetched }, 'VT fetch failed, returning partial results');
      break;
    }
  }

  log.debug({ domain, count: subdomains.length, pagesFetched, rateLimited }, 'VT subdomain fetch complete');
  return { subdomains, pagesFetched, rateLimited };
}
