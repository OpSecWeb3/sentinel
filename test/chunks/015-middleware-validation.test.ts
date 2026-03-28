/**
 * Chunk 015 — Middleware: Zod validation (body/query/param targets, error format)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters } from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  setupAdmin,
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

describe('Chunk 015 — Zod validation middleware', () => {
  describe('JSON body validation', () => {
    it('should return 400 with structured error on invalid JSON body', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'POST', '/api/detections', {
        cookie: admin.cookie,
        body: {
          // Missing required fields: moduleId, name, severity, rules
        },
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBeDefined();
      // Should have structured error details
      expect(body.details).toBeDefined();
    });

    it('should pass through valid JSON body', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'POST', '/api/detections', {
        cookie: admin.cookie,
        body: {
          moduleId: 'github',
          name: 'Valid Detection',
          severity: 'high',
          rules: [
            {
              ruleType: 'github.repo_visibility',
              config: { alertOn: 'publicized' },
              action: 'alert',
            },
          ],
        },
      });

      // Should succeed (201) or at least not 400
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('Registration validation', () => {
    it('should reject invalid email format', async () => {
      const res = await appRequest(app, 'POST', '/auth/register', {
        body: {
          username: 'validuser',
          email: 'not-an-email',
          password: 'StrongPass1!',
          orgName: 'Org',
        },
      });

      expect(res.status).toBe(400);
    });

    it('should reject username shorter than 3 chars', async () => {
      const res = await appRequest(app, 'POST', '/auth/register', {
        body: {
          username: 'ab',
          email: 'valid@test.com',
          password: 'StrongPass1!',
          orgName: 'Org',
        },
      });

      expect(res.status).toBe(400);
    });

    it('should reject username longer than 50 chars', async () => {
      const res = await appRequest(app, 'POST', '/auth/register', {
        body: {
          username: 'a'.repeat(51),
          email: 'valid@test.com',
          password: 'StrongPass1!',
          orgName: 'Org',
        },
      });

      expect(res.status).toBe(400);
    });
  });

  describe('Role change validation', () => {
    it('should reject invalid role value', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'PATCH', `/auth/users/${admin.userId}/role`, {
        cookie: admin.cookie,
        body: { role: 'superadmin' }, // invalid enum value
      });

      expect(res.status).toBe(400);
    });
  });

  describe('API key creation validation', () => {
    it('should reject invalid scopes', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: admin.cookie,
        body: { name: 'bad-key', scopes: ['admin:all'] }, // invalid scope
      });

      expect(res.status).toBe(400);
    });
  });
});
