/**
 * Chunk 017 — Middleware: CORS (origin whitelist, exposed headers, credentials)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters } from '../helpers/setup.js';
import { getApp, appRequest } from '../../apps/api/src/__tests__/helpers.js';
import type { Hono } from 'hono';

let app: Hono<any>;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
});

describe('Chunk 017 — CORS middleware', () => {
  it('should allow requests from whitelisted origin', async () => {
    const res = await app.request('http://localhost/health', {
      method: 'GET',
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
  });

  it('should include credentials support', async () => {
    const res = await app.request('http://localhost/health', {
      method: 'GET',
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('should expose rate limit headers in CORS', async () => {
    const res = await app.request('http://localhost/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    });

    const exposedHeaders = res.headers.get('Access-Control-Expose-Headers') ?? '';
    expect(exposedHeaders).toContain('X-RateLimit-Limit');
    expect(exposedHeaders).toContain('X-RateLimit-Remaining');
    expect(exposedHeaders).toContain('X-RateLimit-Reset');
  });

  it('should handle OPTIONS preflight request', async () => {
    const res = await app.request('http://localhost/api/detections', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization, X-Sentinel-Request',
      },
    });

    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get('Access-Control-Allow-Headers') ?? '';
    expect(allowHeaders).toContain('Content-Type');
    expect(allowHeaders).toContain('Authorization');
    expect(allowHeaders).toContain('X-Sentinel-Request');
  });

  it('should allow all standard HTTP methods', async () => {
    const res = await app.request('http://localhost/api/detections', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'DELETE',
      },
    });

    const allowMethods = res.headers.get('Access-Control-Allow-Methods') ?? '';
    expect(allowMethods).toContain('GET');
    expect(allowMethods).toContain('POST');
    expect(allowMethods).toContain('DELETE');
    expect(allowMethods).toContain('PATCH');
  });
});
