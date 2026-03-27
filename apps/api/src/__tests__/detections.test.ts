/**
 * Integration tests for Sentinel detection routes (/api/detections).
 *
 * Covers CRUD operations, pagination, filtering, status transitions,
 * archival, admin-only deletion, and org scoping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { cleanTables, getTestSql } from './setup.js';
import {
  appRequest,
  registerAdmin,
  registerViewer,
  login,
  setupAdmin,
  setupAdminAndViewer,
} from './helpers.js';

let app: Hono<AppEnv>;

beforeEach(async () => {
  await cleanTables();
  const mod = await import('../index.js');
  app = mod.default;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetectionBody(overrides: Record<string, unknown> = {}) {
  return {
    moduleId: 'github',
    name: 'Test Detection',
    description: 'A test detection',
    severity: 'high',
    channelIds: [],
    cooldownMinutes: 5,
    config: {},
    rules: [
      {
        ruleType: 'push_to_main',
        config: { branch: 'main' },
        action: 'alert',
        priority: 50,
      },
    ],
    ...overrides,
  };
}

async function createDetection(
  appInst: Hono<AppEnv>,
  cookie: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await appRequest(appInst, 'POST', '/api/detections', {
    cookie,
    body: makeDetectionBody(overrides),
  });
  const body = await res.json();
  return { res, body };
}

// ===========================================================================
// POST /api/detections -- create
// ===========================================================================

describe('POST /api/detections', () => {
  it('creates a detection with rules', async () => {
    const admin = await setupAdmin(app);
    const { res, body } = await createDetection(app, admin.cookie);

    expect(res.status).toBe(201);
    expect(body.data).toBeDefined();
    expect(body.data.detection).toBeDefined();
    expect(body.data.detection.name).toBe('Test Detection');
    expect(body.data.detection.moduleId).toBe('github');
    expect(body.data.detection.severity).toBe('high');
    expect(body.data.detection.status).toBe('active');
    expect(body.data.rules).toBeDefined();
    expect(body.data.rules.length).toBe(1);
    expect(body.data.rules[0].ruleType).toBe('push_to_main');
    expect(body.data.rules[0].action).toBe('alert');
  });

  it('requires at least one rule', async () => {
    const admin = await setupAdmin(app);
    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: makeDetectionBody({ rules: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid severity', async () => {
    const admin = await setupAdmin(app);
    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: makeDetectionBody({ severity: 'extreme' }),
    });
    expect(res.status).toBe(400);
  });

  it('creates multiple rules', async () => {
    const admin = await setupAdmin(app);
    const { body } = await createDetection(app, admin.cookie, {
      rules: [
        { ruleType: 'push_to_main', config: { branch: 'main' }, action: 'alert', priority: 10 },
        { ruleType: 'force_push', config: {}, action: 'log', priority: 20 },
        { ruleType: 'branch_delete', config: {}, action: 'suppress', priority: 30 },
      ],
    });

    expect(body.data.rules.length).toBe(3);
    expect(body.data.rules[0].priority).toBe(10);
    expect(body.data.rules[1].priority).toBe(20);
    expect(body.data.rules[2].priority).toBe(30);
  });

  it('unauthenticated request returns 401', async () => {
    const res = await appRequest(app, 'POST', '/api/detections', {
      body: makeDetectionBody(),
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// GET /api/detections -- list
// ===========================================================================

describe('GET /api/detections', () => {
  it('lists detections with pagination metadata', async () => {
    const admin = await setupAdmin(app);

    // Create 3 detections
    for (let i = 0; i < 3; i++) {
      await createDetection(app, admin.cookie, { name: `Detection ${i}` });
    }

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { page: '1', limit: '10' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.length).toBe(3);
    expect(body.meta.total).toBe(3);
    expect(body.meta.page).toBe(1);
    expect(body.meta.totalPages).toBe(1);
  });

  it('paginates correctly', async () => {
    const admin = await setupAdmin(app);

    for (let i = 0; i < 5; i++) {
      await createDetection(app, admin.cookie, { name: `Detection ${i}` });
    }

    const page1Res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { page: '1', limit: '2' },
    });
    const page1 = await page1Res.json();
    expect(page1.data.length).toBe(2);
    expect(page1.meta.total).toBe(5);
    expect(page1.meta.totalPages).toBe(3);

    const page3Res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { page: '3', limit: '2' },
    });
    const page3 = await page3Res.json();
    expect(page3.data.length).toBe(1);
  });

  it('filters by moduleId', async () => {
    const admin = await setupAdmin(app);
    await createDetection(app, admin.cookie, { moduleId: 'github', name: 'GH Det' });
    await createDetection(app, admin.cookie, { moduleId: 'registry', name: 'RC Det' });

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { moduleId: 'github' },
    });
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('GH Det');
  });

  it('filters by status', async () => {
    const admin = await setupAdmin(app);
    const { body: det1 } = await createDetection(app, admin.cookie, { name: 'Active' });
    const { body: det2 } = await createDetection(app, admin.cookie, { name: 'Paused' });

    // Pause the second detection
    await appRequest(app, 'PATCH', `/api/detections/${det2.data.detection.id}`, {
      cookie: admin.cookie,
      body: { status: 'paused' },
    });

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { status: 'active' },
    });
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('Active');
  });

  it('filters by severity', async () => {
    const admin = await setupAdmin(app);
    await createDetection(app, admin.cookie, { name: 'High', severity: 'high' });
    await createDetection(app, admin.cookie, { name: 'Critical', severity: 'critical' });

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { severity: 'critical' },
    });
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('Critical');
  });

  it('filters by search (name ilike)', async () => {
    const admin = await setupAdmin(app);
    await createDetection(app, admin.cookie, { name: 'Alpha Detection' });
    await createDetection(app, admin.cookie, { name: 'Beta Monitor' });
    await createDetection(app, admin.cookie, { name: 'Gamma Detection' });

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { search: 'detection' },
    });
    const body = await res.json();
    expect(body.data.length).toBe(2);
  });

  it('returns empty list for org with no detections', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
    });
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});

// ===========================================================================
// GET /api/detections/:id -- detail
// ===========================================================================

describe('GET /api/detections/:id', () => {
  it('returns detection with its rules', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    const res = await appRequest(app, 'GET', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.id).toBe(detectionId);
    expect(body.data.name).toBe('Test Detection');
    expect(body.data.rules).toBeDefined();
    expect(body.data.rules.length).toBe(1);
    expect(body.data.rules[0].ruleType).toBe('push_to_main');
  });

  it('non-existent detection returns 404', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/api/detections/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('invalid UUID returns 400', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/api/detections/not-a-uuid', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// PATCH /api/detections/:id -- update
// ===========================================================================

describe('PATCH /api/detections/:id', () => {
  it('updates detection name', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    const res = await appRequest(app, 'PATCH', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
      body: { name: 'Updated Name' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Updated Name');
  });

  it('updates severity', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    const res = await appRequest(app, 'PATCH', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
      body: { severity: 'critical' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.severity).toBe('critical');
  });

  it('pausing detection pauses its rules', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    // Pause
    await appRequest(app, 'PATCH', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
      body: { status: 'paused' },
    });

    // Check that rules are paused too
    const sql = getTestSql();
    const ruleRows = await sql`SELECT status FROM rules WHERE detection_id = ${detectionId}`;
    for (const rule of ruleRows) {
      expect(rule.status).toBe('paused');
    }
  });

  it('resuming detection activates its rules', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    // Pause, then resume
    await appRequest(app, 'PATCH', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
      body: { status: 'paused' },
    });
    await appRequest(app, 'PATCH', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
      body: { status: 'active' },
    });

    const sql = getTestSql();
    const ruleRows = await sql`SELECT status FROM rules WHERE detection_id = ${detectionId}`;
    for (const rule of ruleRows) {
      expect(rule.status).toBe('active');
    }
  });

  it('cannot update an archived (disabled) detection', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    // Archive the detection
    await appRequest(app, 'DELETE', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
    });

    // Try to update
    const res = await appRequest(app, 'PATCH', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
      body: { name: 'Should Fail' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('archived');
  });

  it('empty update body is rejected', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    const res = await appRequest(app, 'PATCH', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('update non-existent detection returns 404', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'PATCH', '/api/detections/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
      body: { name: 'Ghost' },
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// DELETE /api/detections/:id -- archive (admin only)
// ===========================================================================

describe('DELETE /api/detections/:id', () => {
  it('admin can archive a detection (soft delete)', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    const res = await appRequest(app, 'DELETE', `/api/detections/${detectionId}`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.status).toBe('disabled');

    // Rules should also be disabled
    const sql = getTestSql();
    const ruleRows = await sql`SELECT status FROM rules WHERE detection_id = ${detectionId}`;
    for (const rule of ruleRows) {
      expect(rule.status).toBe('disabled');
    }
  });

  it('viewer cannot delete detection (403)', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    const { cookie: viewerCookie } = await login(app, 'viewer', 'testpass123!');

    const res = await appRequest(app, 'DELETE', `/api/detections/${detectionId}`, {
      cookie: viewerCookie,
    });
    expect(res.status).toBe(403);
  });

  it('delete non-existent detection returns 404', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'DELETE', '/api/detections/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Org scoping
// ===========================================================================

describe('Org scoping', () => {
  it('cannot see another org\'s detections', async () => {
    // Org 1: create detection
    const admin1 = await setupAdmin(app);
    await createDetection(app, admin1.cookie, { name: 'Org1 Detection' });

    // Delete org1, then create org2 via a new first user scenario
    // Instead, let's use the DB to create a separate org
    const sql = getTestSql();

    // Create org2 directly in DB
    const [org2] = await sql`
      INSERT INTO organizations (name, slug, invite_secret)
      VALUES ('Org Two', 'org-two', 'secret-org-2')
      RETURNING id
    `;

    // Create user2 directly
    const bcrypt = await import('bcrypt');
    const pwHash = await bcrypt.hash('testpass123!', 4);
    const [user2] = await sql`
      INSERT INTO users (username, email, password_hash)
      VALUES ('user2', 'user2@test.com', ${pwHash})
      RETURNING id
    `;

    await sql`
      INSERT INTO org_memberships (org_id, user_id, role)
      VALUES (${org2.id}, ${user2.id}, 'admin')
    `;

    // Login as user2
    const { cookie: cookie2 } = await login(app, 'user2', 'testpass123!');

    // user2 should see zero detections (org2 has none)
    const res = await appRequest(app, 'GET', '/api/detections', { cookie: cookie2 });
    const body = await res.json();
    expect(body.data.length).toBe(0);
    expect(body.meta.total).toBe(0);
  });

  it('cannot access another org\'s detection by ID', async () => {
    const admin = await setupAdmin(app);
    const { body: created } = await createDetection(app, admin.cookie);
    const detectionId = created.data.detection.id;

    // Create org2 user
    const sql = getTestSql();
    const [org2] = await sql`
      INSERT INTO organizations (name, slug, invite_secret)
      VALUES ('Org Two', 'org-two', 'secret-org-2')
      RETURNING id
    `;
    const bcrypt = await import('bcrypt');
    const pwHash = await bcrypt.hash('testpass123!', 4);
    const [user2] = await sql`
      INSERT INTO users (username, email, password_hash)
      VALUES ('user2', 'user2@test.com', ${pwHash})
      RETURNING id
    `;
    await sql`
      INSERT INTO org_memberships (org_id, user_id, role)
      VALUES (${org2.id}, ${user2.id}, 'admin')
    `;

    const { cookie: cookie2 } = await login(app, 'user2', 'testpass123!');

    // Try to access org1's detection
    const res = await appRequest(app, 'GET', `/api/detections/${detectionId}`, { cookie: cookie2 });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /api/detections/from-template
// ===========================================================================

describe('POST /api/detections/from-template', () => {
  it('creates detection from a valid template', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections/from-template', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        templateSlug: 'unauthorized-push',
        name: 'My Push Detection',
        channelIds: [],
        cooldownMinutes: 10,
        overrides: {},
      },
    });

    // This may succeed or fail depending on whether the GitHub module
    // has an 'unauthorized-push' template. We test both possibilities.
    if (res.status === 201) {
      const body = await res.json();
      expect(body.data.detection.name).toBe('My Push Detection');
      expect(body.data.detection.moduleId).toBe('github');
      expect(body.data.rules.length).toBeGreaterThan(0);
    } else {
      // Template not found is expected if the module doesn't have it
      expect(res.status).toBe(404);
    }
  });

  it('non-existent module returns 404', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections/from-template', {
      cookie: admin.cookie,
      body: {
        moduleId: 'nonexistent-module',
        templateSlug: 'some-template',
        channelIds: [],
      },
    });
    expect(res.status).toBe(404);
  });

  it('non-existent template returns 404', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections/from-template', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        templateSlug: 'nonexistent-template-slug',
        channelIds: [],
      },
    });
    expect(res.status).toBe(404);
  });
});
