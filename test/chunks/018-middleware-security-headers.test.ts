/**
 * Chunk 018 — Middleware: Security headers (HSTS prod-only, CSP, X-Frame-Options)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
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

describe('Chunk 018 — Security headers', () => {
  it('should set X-Content-Type-Options: nosniff', async () => {
    const res = await appRequest(app, 'GET', '/health', {});
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('should set X-Frame-Options: DENY', async () => {
    const res = await appRequest(app, 'GET', '/health', {});
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('should set Referrer-Policy', async () => {
    const res = await appRequest(app, 'GET', '/health', {});
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('should set X-XSS-Protection: 0', async () => {
    const res = await appRequest(app, 'GET', '/health', {});
    expect(res.headers.get('X-XSS-Protection')).toBe('0');
  });

  it('should set Permissions-Policy', async () => {
    const res = await appRequest(app, 'GET', '/health', {});
    const policy = res.headers.get('Permissions-Policy') ?? '';
    expect(policy).toContain('camera=()');
    expect(policy).toContain('microphone=()');
    expect(policy).toContain('geolocation=()');
  });

  it('should NOT set HSTS in non-production environment', async () => {
    // Tests run with NODE_ENV=test
    const res = await appRequest(app, 'GET', '/health', {});
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
  });

  describe('CSRF defense', () => {
    it('should require X-Sentinel-Request header on cookie-authenticated POST', async () => {
      const { setupAdmin } = await import('../../apps/api/src/__tests__/helpers.js');
      const admin = await setupAdmin(app);

      // Send POST without CSRF header (bypass appRequest which auto-adds it)
      const res = await app.request('http://localhost/api/detections', {
        method: 'POST',
        headers: {
          Cookie: admin.cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          moduleId: 'github',
          name: 'CSRF Test',
          severity: 'high',
          rules: [{ ruleType: 'github.repo_visibility', config: {}, action: 'alert' }],
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toMatch(/CSRF/i);
    });

    it('should skip CSRF check for GET requests', async () => {
      const { setupAdmin } = await import('../../apps/api/src/__tests__/helpers.js');
      const admin = await setupAdmin(app);

      // GET without CSRF header should be fine
      const res = await app.request('http://localhost/auth/me', {
        method: 'GET',
        headers: { Cookie: admin.cookie },
      });

      expect(res.status).toBe(200);
    });

    it('should skip CSRF check for Bearer token requests', async () => {
      const { setupAdmin, createApiKey } = await import('../../apps/api/src/__tests__/helpers.js');
      const admin = await setupAdmin(app);
      const { key } = await createApiKey(app, admin.cookie, 'csrf-test', ['api:read', 'api:write']);

      // POST with API key but no CSRF header
      const res = await app.request('http://localhost/api/detections', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          moduleId: 'github',
          name: 'API Key Detection',
          severity: 'high',
          rules: [{ ruleType: 'github.repo_visibility', config: {}, action: 'alert' }],
        }),
      });

      // Should not be 403 CSRF (might be other errors, but not CSRF)
      if (res.status === 403) {
        const body = await res.json() as any;
        expect(body.error).not.toMatch(/CSRF/i);
      }
    });
  });
});
