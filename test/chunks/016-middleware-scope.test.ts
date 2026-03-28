/**
 * Chunk 016 — Middleware: Scope enforcement (session role bypass vs API key exact scope)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters } from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  setupAdmin,
  setupAdminAndViewer,
  createApiKey,
  registerViewer,
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

describe('Chunk 016 — Scope enforcement', () => {
  describe('Session role bypass', () => {
    it('should bypass scope check for admin session', async () => {
      const admin = await setupAdmin(app);

      // api:write scope required, admin should bypass
      const res = await appRequest(app, 'POST', '/api/detections', {
        cookie: admin.cookie,
        body: {
          moduleId: 'github',
          name: 'Admin Detection',
          severity: 'high',
          rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
        },
      });

      expect(res.status).toBeLessThan(400);
    });

    it('should allow viewer session to access read endpoints', async () => {
      const admin = await setupAdmin(app);
      const viewer = await registerViewer(app, admin.inviteSecret, {
        username: 'viewer1',
        email: 'viewer1@test.com',
      });

      const res = await appRequest(app, 'GET', '/api/detections', {
        cookie: viewer.cookie,
      });

      expect(res.status).toBe(200);
    });

    it('should reject viewer session on write endpoints', async () => {
      const admin = await setupAdmin(app);
      const viewer = await registerViewer(app, admin.inviteSecret, {
        username: 'viewer1',
        email: 'viewer1@test.com',
      });

      const res = await appRequest(app, 'POST', '/api/detections', {
        cookie: viewer.cookie,
        body: {
          moduleId: 'github',
          name: 'Viewer Detection',
          severity: 'high',
          rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
        },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('API key exact scope', () => {
    it('should allow API key with matching scope', async () => {
      const admin = await setupAdmin(app);
      const { key } = await createApiKey(app, admin.cookie, 'read-key', ['api:read']);

      const res = await appRequest(app, 'GET', '/api/detections', {
        headers: { Authorization: `Bearer ${key}` },
      });

      expect(res.status).toBe(200);
    });

    it('should reject API key without required scope', async () => {
      const admin = await setupAdmin(app);
      const { key } = await createApiKey(app, admin.cookie, 'read-only', ['api:read']);

      const res = await appRequest(app, 'POST', '/api/detections', {
        headers: { Authorization: `Bearer ${key}` },
        body: {
          moduleId: 'github',
          name: 'No Write Scope',
          severity: 'high',
          rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
        },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toMatch(/scope/i);
    });

    it('should allow API key with api:write on write endpoints', async () => {
      const admin = await setupAdmin(app);
      const { key } = await createApiKey(app, admin.cookie, 'write-key', ['api:read', 'api:write']);

      const res = await appRequest(app, 'POST', '/api/detections', {
        headers: { Authorization: `Bearer ${key}` },
        body: {
          moduleId: 'github',
          name: 'Write Key Detection',
          severity: 'high',
          rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
        },
      });

      expect(res.status).toBeLessThan(400);
    });
  });
});
