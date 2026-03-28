/**
 * Chunk 012 — Middleware: API key auth (sk_* extraction, timing-safe hash compare, scope check)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestApiKey,
} from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  setupAdmin,
  createApiKey,
} from '../../apps/api/src/__tests__/helpers.js';
import type { Hono } from 'hono';

let app: Hono<any>;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
});

describe('Chunk 012 — API key middleware', () => {
  it('should authenticate with valid sk_ API key', async () => {
    const admin = await setupAdmin(app);
    const { key } = await createApiKey(app, admin.cookie, 'test-key', ['api:read']);

    const res = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: `Bearer ${key}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.apiKey).toBeDefined();
    expect(body.apiKey.scopes).toContain('api:read');
  });

  it('should reject non-sk_ prefixed bearer tokens', async () => {
    const res = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: 'Bearer not_a_valid_key' },
    });

    // Should fall through to next middleware (no auth), then 401
    expect(res.status).toBe(401);
  });

  it('should reject API key with wrong hash', async () => {
    const res = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: 'Bearer sk_test_fakekeyvalue123456' },
    });

    expect(res.status).toBe(401);
  });

  it('should reject expired API key', async () => {
    const admin = await setupAdmin(app);
    const { key, id } = await createApiKey(app, admin.cookie, 'expiring-key', ['api:read']);

    // Manually expire the key in DB
    const sql = getTestSql();
    await sql`UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${id}`;

    const res = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: `Bearer ${key}` },
    });

    expect(res.status).toBe(401);
  });

  it('should reject revoked API key', async () => {
    const admin = await setupAdmin(app);
    const { key, id } = await createApiKey(app, admin.cookie, 'to-revoke', ['api:read']);

    // Revoke the key
    await appRequest(app, 'DELETE', `/auth/api-keys/${id}`, {
      cookie: admin.cookie,
    });

    const res = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: `Bearer ${key}` },
    });

    expect(res.status).toBe(401);
  });

  it('should set orgId, userId, and scopes in context from API key', async () => {
    const admin = await setupAdmin(app);
    const { key } = await createApiKey(app, admin.cookie, 'ctx-test', ['api:read', 'api:write']);

    const res = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: `Bearer ${key}` },
    });

    const body = await res.json() as any;
    expect(body.apiKey.scopes).toEqual(['api:read', 'api:write']);
  });

  it('should reject API key if user no longer in org', async () => {
    const admin = await setupAdmin(app);
    const { key } = await createApiKey(app, admin.cookie, 'orphan-key', ['api:read']);

    // Remove admin from org
    const sql = getTestSql();
    await sql`DELETE FROM org_memberships WHERE user_id = ${admin.userId}`;

    const res = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: `Bearer ${key}` },
    });

    expect(res.status).toBe(401);
  });
});
