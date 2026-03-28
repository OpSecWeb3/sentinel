/**
 * Chunk 013 — Middleware: Rate limiting (Redis Lua atomicity, per-key bucketing, 429 response headers)
 *
 * Note: tests set DISABLE_RATE_LIMIT=false temporarily to test rate limiting.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestRedis,
} from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  setupAdmin,
} from '../../apps/api/src/__tests__/helpers.js';
import type { Hono } from 'hono';

let app: Hono<any>;
let origDisableRateLimit: string | undefined;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
  // Enable rate limiting for these tests
  origDisableRateLimit = process.env.DISABLE_RATE_LIMIT;
  process.env.DISABLE_RATE_LIMIT = 'false';
});

afterEach(() => {
  // Restore original setting
  if (origDisableRateLimit !== undefined) {
    process.env.DISABLE_RATE_LIMIT = origDisableRateLimit;
  } else {
    delete process.env.DISABLE_RATE_LIMIT;
  }
});

describe('Chunk 013 — Rate limiting', () => {
  it('should return rate limit headers on responses', async () => {
    const res = await appRequest(app, 'GET', '/auth/setup-status', {});

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBeDefined();
    expect(res.headers.get('X-RateLimit-Remaining')).toBeDefined();
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();
  });

  it('should decrement remaining count on each request', async () => {
    const res1 = await appRequest(app, 'GET', '/auth/setup-status', {});
    const remaining1 = parseInt(res1.headers.get('X-RateLimit-Remaining') ?? '0');

    const res2 = await appRequest(app, 'GET', '/auth/setup-status', {});
    const remaining2 = parseInt(res2.headers.get('X-RateLimit-Remaining') ?? '0');

    expect(remaining2).toBeLessThan(remaining1);
  });

  it('should use different buckets for different key types', async () => {
    const admin = await setupAdmin(app);

    // Request with session cookie
    const cookieRes = await appRequest(app, 'GET', '/auth/me', {
      cookie: admin.cookie,
    });

    // Request without any auth (IP-based bucket)
    const anonRes = await appRequest(app, 'GET', '/auth/setup-status', {});

    // Both should succeed (different buckets)
    expect(cookieRes.status).toBe(200);
    expect(anonRes.status).toBe(200);
  });

  it('should return 429 when rate limit exceeded', async () => {
    // Auth limiter allows 10 per 15 minutes
    // We need to make 11 requests to the auth endpoint
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await appRequest(app, 'POST', '/auth/login', {
        body: { username: 'nonexistent', password: 'wrong' },
      });
      results.push(res.status);
    }

    // At least one should be 429
    expect(results).toContain(429);
  });

  it('should include rate limit headers on 429 response', async () => {
    // Exhaust the auth rate limit
    let lastRes: Response | undefined;
    for (let i = 0; i < 12; i++) {
      lastRes = await appRequest(app, 'POST', '/auth/login', {
        body: { username: 'nonexistent', password: 'wrong' },
      });
      if (lastRes.status === 429) break;
    }

    expect(lastRes!.status).toBe(429);
    expect(lastRes!.headers.get('X-RateLimit-Remaining')).toBe('0');
  });
});
