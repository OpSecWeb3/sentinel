/**
 * Chunk 014 — Middleware: Request context (requestId from header or generated, child logger)
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

describe('Chunk 014 — Request context middleware', () => {
  it('should generate X-Request-Id when not provided', async () => {
    const res = await appRequest(app, 'GET', '/health', {});

    expect(res.status).toBe(200);
    const requestId = res.headers.get('X-Request-Id');
    expect(requestId).toBeDefined();
    expect(requestId!.length).toBeGreaterThan(0);
  });

  it('should echo back X-Request-Id when provided', async () => {
    const customId = 'custom-request-id-12345';
    const res = await appRequest(app, 'GET', '/health', {
      headers: { 'X-Request-Id': customId },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBe(customId);
  });

  it('should generate unique request IDs for different requests', async () => {
    const res1 = await appRequest(app, 'GET', '/health', {});
    const res2 = await appRequest(app, 'GET', '/health', {});

    const id1 = res1.headers.get('X-Request-Id');
    const id2 = res2.headers.get('X-Request-Id');

    expect(id1).not.toBe(id2);
  });

  it('should include request ID on error responses', async () => {
    const res = await appRequest(app, 'GET', '/nonexistent-route', {});

    expect(res.status).toBe(404);
    expect(res.headers.get('X-Request-Id')).toBeDefined();
  });
});
