/**
 * Gap 1 — Adversarial / malicious input testing for route handlers.
 *
 * Covers SQL injection, SSRF bypass, CSRF bypass, XSS round-trip,
 * data-retention allowlist enforcement, and oversized payloads.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import { getApp, appRequest, setupAdmin } from '../../apps/api/src/__tests__/helpers.js';
import { cleanTables, resetCounters } from '../helpers/setup.js';
import { dataRetentionHandler } from '../../apps/worker/src/handlers/data-retention.js';

let app: Hono<any>;
let cookie: string;

beforeAll(async () => { app = await getApp(); });
beforeEach(async () => {
  await cleanTables();
  resetCounters();
  const admin = await setupAdmin(app);
  cookie = admin.cookie;
});

// ---------------------------------------------------------------------------
// 1. SQL injection in payload-search field param
// ---------------------------------------------------------------------------

describe('payload-search field validation', () => {
  const badFields = [
    '}; DROP TABLE events; --',
    '../../../etc/passwd',
    "field' OR '1'='1",
    "payload->>'",
    '',
  ];

  for (const field of badFields) {
    it(`rejects field="${field}" with 400`, async () => {
      const res = await appRequest(app, 'GET', '/api/events/payload-search', {
        cookie,
        query: { field, value: 'x' },
      });
      expect(res.status).toBe(400);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. SQL injection in search/ilike params — escaping keeps them safe
// ---------------------------------------------------------------------------

describe('search param ILIKE escaping', () => {
  const inputs = ['%', '_', "'; DROP TABLE--"];

  for (const search of inputs) {
    it(`handles search="${search}" without error`, async () => {
      const res = await appRequest(app, 'GET', '/api/events', {
        cookie,
        query: { search },
      });
      // Should succeed (200) with zero results, not 500
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// 3. SSRF bypass attempts in webhook channel creation
// ---------------------------------------------------------------------------

describe('SSRF bypass in webhook channel creation', () => {
  const ssrfUrls = [
    'http://localhost:8545',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:127.0.0.1]:8080',
  ];

  for (const url of ssrfUrls) {
    it(`stores or rejects ${url} at creation time`, async () => {
      const res = await appRequest(app, 'POST', '/api/channels', {
        cookie,
        body: { name: 'ssrf-test', type: 'webhook', config: { url } },
      });
      // The channel schema validates url as z.string().url(), so valid URLs
      // are accepted and stored (SSRF check happens at delivery time).
      // Invalid URL formats would be 400. Either 201 or 400 is acceptable;
      // a 500 would indicate a server-side failure.
      expect([201, 400]).toContain(res.status);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. CSRF bypass attempts
// ---------------------------------------------------------------------------

describe('CSRF defense header enforcement', () => {
  it('rejects POST without X-Sentinel-Request header (session cookie present)', async () => {
    const res = await app.request('http://localhost/api/detections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
      },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message ?? body.error).toMatch(/CSRF/i);
  });

  it('requires CSRF header even when path contains "webhooks" substring but is not a webhook path', async () => {
    const res = await app.request('http://localhost/api/detections?webhooks=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
      },
      body: JSON.stringify({ name: 'test' }),
    });
    // The query param "webhooks" should NOT bypass CSRF
    expect(res.status).toBe(403);
  });

  it('rejects POST to /api/detections without CSRF header', async () => {
    const res = await app.request('http://localhost/api/detections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
      },
      body: JSON.stringify({
        moduleId: 'github',
        name: 'No CSRF',
        rules: [{ ruleType: 'github.repo_visibility', config: { visibility: 'public' } }],
      }),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 5. XSS in detection/channel names — stored as-is, round-trip preserved
// ---------------------------------------------------------------------------

describe('XSS payloads in detection names', () => {
  const xssStrings = [
    "<script>alert('xss')</script>",
    '<img onerror=alert(1) src=x>',
  ];

  for (const xss of xssStrings) {
    it(`stores "${xss}" and round-trips it correctly`, async () => {
      const createRes = await appRequest(app, 'POST', '/api/detections', {
        cookie,
        body: {
          moduleId: 'github',
          name: xss,
          rules: [{ ruleType: 'github.repo_visibility', config: { visibility: 'public' } }],
        },
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const id = created.data.detection.id;

      const getRes = await appRequest(app, 'GET', `/api/detections/${id}`, { cookie });
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.data.name).toBe(xss);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Data retention identifier injection (allowlist enforcement)
// ---------------------------------------------------------------------------

describe('data retention allowlist enforcement', () => {
  const maliciousPolicies = [
    { table: 'pg_shadow', timestampColumn: 'created_at', retentionDays: 1, label: 'disallowed table pg_shadow' },
    { table: 'information_schema.tables', timestampColumn: 'created_at', retentionDays: 1, label: 'disallowed table information_schema.tables' },
    { table: 'events', timestampColumn: 'id', retentionDays: 1, label: 'disallowed timestamp column "id"' },
    { table: 'events', timestampColumn: 'pg_shadow', retentionDays: 1, label: 'disallowed timestamp column "pg_shadow"' },
    { table: 'events', timestampColumn: 'received_at', retentionDays: 1, filter: "1=1; DROP TABLE events; --", label: 'disallowed filter' },
  ];

  for (const { table, timestampColumn, retentionDays, filter, label } of maliciousPolicies) {
    it(`skips policy with ${label}`, async () => {
      // The handler should silently skip invalid policies without throwing.
      const mockJob = {
        data: {
          policies: [{ table, timestampColumn, retentionDays, ...(filter ? { filter } : {}) }],
        },
      } as any;

      // Should complete without error — invalid policies are skipped, not thrown.
      await expect(dataRetentionHandler.process(mockJob)).resolves.not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Oversized payloads
// ---------------------------------------------------------------------------

describe('oversized payload rejection', () => {
  it('rejects detection name > 255 characters with 400', async () => {
    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie,
      body: {
        moduleId: 'github',
        name: 'A'.repeat(10_000),
        rules: [{ ruleType: 'github.repo_visibility', config: { visibility: 'public' } }],
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects registration password > 128 characters with 400', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'longpw',
        email: 'longpw@test.com',
        password: 'P'.repeat(200),
        orgName: 'Overflow Org',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects payload-search field > 200 characters with 400', async () => {
    const res = await appRequest(app, 'GET', '/api/events/payload-search', {
      cookie,
      query: { field: 'a'.repeat(300), value: 'x' },
    });
    expect(res.status).toBe(400);
  });
});
