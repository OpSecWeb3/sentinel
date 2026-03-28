/**
 * Chunk 008 — Auth: API key CRUD (create, list, revoke, scope enforcement, expiry)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters, getTestSql } from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  extractCookie,
  setupAdmin,
  setupAdminAndViewer,
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

describe('Chunk 008 — API Key CRUD', () => {
  describe('Create', () => {
    it('should create an API key with default read scope', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: 'my-key' },
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.key).toBeDefined();
      expect(body.key).toMatch(/^sk_/);
      expect(body.prefix).toBeDefined();
      expect(body.name).toBe('my-key');
      expect(body.scopes).toEqual(['api:read']);
      expect(body.warning).toMatch(/save this key/i);
    });

    it('should create an API key with write scope', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: 'rw-key', scopes: ['api:read', 'api:write'] },
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.scopes).toEqual(['api:read', 'api:write']);
    });

    it('should create an API key with expiry', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: 'expiring-key', expiresInDays: 30 },
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.expiresAt).toBeDefined();
      const expiresAt = new Date(body.expiresAt);
      const now = new Date();
      const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(29);
      expect(diffDays).toBeLessThan(31);
    });

    it('should reject empty key name', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: '' },
      });

      expect(res.status).toBe(400);
    });
  });

  describe('List', () => {
    it('should list API keys without exposing the raw key', async () => {
      const admin = await setupAdmin(app);

      // Create a key
      await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: 'listed-key' },
      });

      // List keys
      const res = await appRequest(app, 'GET', '/auth/api-keys', {
        cookie: admin.cookie,
      });

      expect(res.status).toBe(200);
      const keys = await res.json() as any[];
      expect(keys.length).toBeGreaterThanOrEqual(1);

      const listed = keys.find((k: any) => k.name === 'listed-key');
      expect(listed).toBeDefined();
      expect(listed.keyPrefix).toBeDefined();
      // Raw key should never appear in list
      expect(listed.key).toBeUndefined();
      expect(listed.keyHash).toBeUndefined();
    });
  });

  describe('Revoke', () => {
    it('should revoke an API key by ID', async () => {
      const admin = await setupAdmin(app);

      const createRes = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: 'to-revoke' },
      });
      const { id } = await createRes.json() as any;

      const revokeRes = await appRequest(app, 'DELETE', `/auth/api-keys/${id}`, {
        cookie: admin.cookie,
      });

      expect(revokeRes.status).toBe(200);
      const body = await revokeRes.json() as any;
      expect(body.status).toBe('revoked');

      // Verify it shows as revoked in list
      const listRes = await appRequest(app, 'GET', '/auth/api-keys', {
        cookie: admin.cookie,
      });
      const keys = await listRes.json() as any[];
      const revoked = keys.find((k: any) => k.id === id);
      expect(revoked?.revoked).toBe(true);
    });

    it('should return 404 for non-existent key', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'DELETE', '/auth/api-keys/00000000-0000-0000-0000-000000000000', {
        cookie: admin.cookie,
      });

      expect(res.status).toBe(404);
    });
  });

  describe('Scope enforcement', () => {
    it('should authenticate with valid API key', async () => {
      const admin = await setupAdmin(app);

      const createRes = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: 'auth-test', scopes: ['api:read'] },
      });
      const { key } = await createRes.json() as any;

      // Use the API key to access /auth/me
      const meRes = await appRequest(app, 'GET', '/auth/me', {
        headers: { Authorization: `Bearer ${key}` },
      });

      expect(meRes.status).toBe(200);
      const me = await meRes.json() as any;
      expect(me.apiKey).toBeDefined();
      expect(me.apiKey.scopes).toContain('api:read');
    });

    it('should reject revoked API key', async () => {
      const admin = await setupAdmin(app);

      const createRes = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: 'revoke-test', scopes: ['api:read'] },
      });
      const { key, id } = await createRes.json() as any;

      // Revoke the key
      await appRequest(app, 'DELETE', `/auth/api-keys/${id}`, {
        cookie: admin.cookie,
      });

      // Try using revoked key
      const meRes = await appRequest(app, 'GET', '/auth/me', {
        headers: { Authorization: `Bearer ${key}` },
      });

      expect(meRes.status).toBe(401);
    });
  });
});
