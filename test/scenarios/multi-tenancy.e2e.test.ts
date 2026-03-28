/**
 * Multi-tenancy and auth security boundary E2E tests.
 *
 * Validates cross-org data isolation, RBAC, API key scoping, login lockout,
 * session invalidation, CSRF protection, and notify key limitations.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  getTestDb,
  getTestSql,
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestUserWithOrg,
  createTestApiKey,
  createTestDetection,
  createTestSession,
} from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  registerAdmin,
  registerViewer,
  login,
  extractCookie,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert an alert directly via SQL (no helper exists). */
async function createTestAlert(
  orgId: string,
  detectionId: string | null,
  overrides: Partial<{
    severity: string;
    title: string;
    triggerType: string;
    triggerData: Record<string, unknown>;
  }> = {},
): Promise<{ id: string; orgId: string }> {
  const sql = getTestSql();
  const severity = overrides.severity ?? 'high';
  const title = overrides.title ?? 'Test Alert';
  const triggerType = overrides.triggerType ?? 'immediate';
  const triggerData = overrides.triggerData ?? {};

  const [row] = await sql`
    INSERT INTO alerts (org_id, detection_id, severity, title, trigger_type, trigger_data)
    VALUES (${orgId}, ${detectionId}, ${severity}, ${title}, ${triggerType}, ${JSON.stringify(triggerData)}::jsonb)
    RETURNING id, org_id
  `;
  return { id: row.id, orgId: row.org_id };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Cross-Org Data Isolation
// ═══════════════════════════════════════════════════════════════════════════

// Sentinel currently supports a single org — multi-org is not yet implemented.
// These tests document the expected behavior when multi-org support is added.
describe.skip('Cross-Org Data Isolation', () => {
  it('should not return detections from another org', async () => {
    // Set up Org A via API (first org — created by register)
    const adminA = await registerAdmin(app, {
      username: 'adminA',
      email: 'adminA@test.com',
      orgName: 'Org A',
    });
    expect(adminA.res.status).toBeLessThan(400);
    expect(adminA.cookie).toBeTruthy();

    // Create detections in Org A via API
    const createRes = await appRequest(app, 'POST', '/api/detections', {
      cookie: adminA.cookie,
      body: {
        moduleId: 'github',
        name: 'Org A Detection 1',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });
    expect(createRes.status).toBeLessThan(400);

    await appRequest(app, 'POST', '/api/detections', {
      cookie: adminA.cookie,
      body: {
        moduleId: 'github',
        name: 'Org A Detection 2',
        severity: 'critical',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });

    // Set up Org B via DB (API only allows one org creation — the first).
    // Manually create a session for User B to bypass password hashing mismatch.
    const orgB = await createTestOrg({ name: 'Org B', slug: 'org-b' });
    const userB = await createTestUser({ username: 'adminB', email: 'adminB@test.com' });
    await addMembership(orgB.id, userB.id, 'admin');

    const crypto = await import('node:crypto');
    const sidB = crypto.randomBytes(32).toString('base64url');
    const sql = getTestSql();
    // Encrypt session data using the same encryption the app uses
    const { encryptSession } = await import('../../apps/api/src/middleware/session.js');
    await sql`INSERT INTO sessions (sid, sess, expire)
      VALUES (${sidB}, ${encryptSession({ userId: userB.id, orgId: orgB.id, role: 'admin' })}, ${new Date(Date.now() + 86400000)})`;
    const cookieB = `sentinel.sid=${sidB}`;

    // Authenticate as User B and list detections
    const listRes = await appRequest(app, 'GET', '/api/detections', {
      cookie: cookieB,
    });
    expect(listRes.status).toBe(200);

    const listBody = (await listRes.json()) as { data: unknown[] };
    // User B should see 0 detections (not Org A's)
    expect(listBody.data).toHaveLength(0);
  });

  it('should not return alerts from another org', async () => {
    // Register Org A admin and create data
    const adminA = await registerAdmin(app, {
      username: 'adminA',
      email: 'adminA@test.com',
      orgName: 'Org A',
    });
    const orgAId = (adminA.body.org as Record<string, unknown>).id as string;

    // Insert alerts directly in Org A
    await createTestAlert(orgAId, null, { title: 'Org A Alert 1' });
    await createTestAlert(orgAId, null, { title: 'Org A Alert 2' });

    // Register Org B admin
    const adminB = await registerAdmin(app, {
      username: 'adminB',
      email: 'adminB@test.com',
      orgName: 'Org B',
    });

    // Authenticate as User B and list alerts
    const listRes = await appRequest(app, 'GET', '/api/alerts', {
      cookie: adminB.cookie,
    });
    expect(listRes.status).toBe(200);

    const listBody = (await listRes.json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(0);
  });

  it('should scope channels to the authenticated org', async () => {
    // Register Org A and create a channel
    const adminA = await registerAdmin(app, {
      username: 'adminA',
      email: 'adminA@test.com',
      orgName: 'Org A',
    });

    const channelRes = await appRequest(app, 'POST', '/api/channels', {
      cookie: adminA.cookie,
      body: {
        name: 'Org A Slack Channel',
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.com/test-orgA' },
      },
    });
    // Channel creation should succeed (or at least not be unauthorized)
    expect(channelRes.status).toBeLessThan(500);

    // Register Org B
    const adminB = await registerAdmin(app, {
      username: 'adminB',
      email: 'adminB@test.com',
      orgName: 'Org B',
    });

    // List channels as Org B - should be empty
    const listRes = await appRequest(app, 'GET', '/api/channels', {
      cookie: adminB.cookie,
    });
    expect(listRes.status).toBe(200);

    const listBody = (await listRes.json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Role-Based Access Control
// ═══════════════════════════════════════════════════════════════════════════

describe('Role-Based Access Control', () => {
  it('should deny viewer from creating a detection', async () => {
    // Register admin (creates org) and get the invite secret
    const admin = await registerAdmin(app, {
      username: 'owner',
      email: 'owner@test.com',
      orgName: 'RBAC Org',
    });
    const inviteSecret = admin.body.inviteSecret as string;

    // Register viewer using the invite secret
    const viewer = await registerViewer(app, inviteSecret, {
      username: 'viewer',
      email: 'viewer@test.com',
    });

    // Viewer attempts to create a detection
    const createRes = await appRequest(app, 'POST', '/api/detections', {
      cookie: viewer.cookie,
      body: {
        moduleId: 'github',
        name: 'Unauthorized Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });
    expect(createRes.status).toBe(403);
  });

  it('should allow editor to create a detection', async () => {
    // Register admin
    const admin = await registerAdmin(app, {
      username: 'owner',
      email: 'owner@test.com',
      orgName: 'RBAC Org',
    });
    const orgId = (admin.body.org as Record<string, unknown>).id as string;
    const inviteSecret = admin.body.inviteSecret as string;

    // Register a second user (gets viewer role by default)
    const editorReg = await registerViewer(app, inviteSecret, {
      username: 'editoruser',
      email: 'editor@test.com',
    });
    const editorUserId = (editorReg.body.user as Record<string, unknown>).id as string;

    // Promote to editor directly in DB
    const sql = getTestSql();
    await sql`
      UPDATE org_memberships SET role = 'editor'
      WHERE org_id = ${orgId} AND user_id = ${editorUserId}
    `;

    // Editor needs to re-login to get updated session with new role
    const editorLogin = await login(app, 'editoruser', 'testpass123!');
    expect(editorLogin.res.status).toBe(200);

    // Editor attempts to create a detection
    const createRes = await appRequest(app, 'POST', '/api/detections', {
      cookie: editorLogin.cookie,
      body: {
        moduleId: 'github',
        name: 'Editor Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });
    // Editor should be able to create detections (200 or 201)
    expect(createRes.status).toBeLessThan(400);
  });

  it('should deny viewer from deleting a detection', async () => {
    // Register admin and create a detection
    const admin = await registerAdmin(app, {
      username: 'owner',
      email: 'owner@test.com',
      orgName: 'RBAC Org',
    });
    const inviteSecret = admin.body.inviteSecret as string;

    const createRes = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        name: 'Admin Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });
    const createBody = (await createRes.json()) as Record<string, unknown>;
    const data = createBody.data as Record<string, unknown>;
    const detectionId = (data?.detection as Record<string, unknown>)?.id
      ?? (createBody.detection as Record<string, unknown>)?.id
      ?? createBody.id;

    // Register viewer
    const viewer = await registerViewer(app, inviteSecret, {
      username: 'viewer',
      email: 'viewer@test.com',
    });

    // Viewer attempts to delete the detection
    const deleteRes = await appRequest(app, 'DELETE', `/api/detections/${detectionId}`, {
      cookie: viewer.cookie,
    });
    expect(deleteRes.status).toBe(403);
  });

  it('should deny editor from deleting a detection (admin-only)', async () => {
    // Register admin and create a detection
    const admin = await registerAdmin(app, {
      username: 'owner',
      email: 'owner@test.com',
      orgName: 'RBAC Org',
    });
    const orgId = (admin.body.org as Record<string, unknown>).id as string;
    const inviteSecret = admin.body.inviteSecret as string;

    const createRes = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        name: 'Admin Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });
    const createBody = (await createRes.json()) as Record<string, unknown>;
    const data = createBody.data as Record<string, unknown>;
    const detectionId = (data?.detection as Record<string, unknown>)?.id
      ?? (createBody.detection as Record<string, unknown>)?.id
      ?? createBody.id;

    // Register editor (promoted from viewer)
    const editorReg = await registerViewer(app, inviteSecret, {
      username: 'editoruser',
      email: 'editor@test.com',
    });
    const editorUserId = (editorReg.body.user as Record<string, unknown>).id as string;

    const sql = getTestSql();
    await sql`
      UPDATE org_memberships SET role = 'editor'
      WHERE org_id = ${orgId} AND user_id = ${editorUserId}
    `;

    // Re-login as editor to pick up new role
    const editorLogin = await login(app, 'editoruser', 'testpass123!');

    // Editor attempts to delete (DELETE requires 'admin' role per the route definition)
    const deleteRes = await appRequest(app, 'DELETE', `/api/detections/${detectionId}`, {
      cookie: editorLogin.cookie,
    });
    expect(deleteRes.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. API Key Org Scoping
// ═══════════════════════════════════════════════════════════════════════════

// Requires multi-org support (not yet implemented)
describe.skip('API Key Org Scoping', () => {
  it('should only return detections for the API key org', async () => {
    // Set up Org A with admin, detection, and API key
    const adminA = await registerAdmin(app, {
      username: 'adminA',
      email: 'adminA@test.com',
      orgName: 'Org A',
    });
    const orgAId = (adminA.body.org as Record<string, unknown>).id as string;
    const userAId = (adminA.body.user as Record<string, unknown>).id as string;

    // Create a detection in Org A via API
    await appRequest(app, 'POST', '/api/detections', {
      cookie: adminA.cookie,
      body: {
        moduleId: 'github',
        name: 'Org A Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });

    // Create API key for Org A
    const apiKeyA = await createTestApiKey(orgAId, userAId, {
      scopes: ['api:read', 'api:write'],
    });

    // Set up Org B with a detection
    const adminB = await registerAdmin(app, {
      username: 'adminB',
      email: 'adminB@test.com',
      orgName: 'Org B',
    });

    await appRequest(app, 'POST', '/api/detections', {
      cookie: adminB.cookie,
      body: {
        moduleId: 'github',
        name: 'Org B Detection',
        severity: 'critical',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });

    // Query detections with Org A's API key
    const listRes = await appRequest(app, 'GET', '/api/detections', {
      headers: {
        Authorization: `Bearer ${apiKeyA.raw}`,
      },
    });
    expect(listRes.status).toBe(200);

    const listBody = (await listRes.json()) as { data: Array<Record<string, unknown>> };
    // Should only see Org A's detection
    expect(listBody.data.length).toBeGreaterThanOrEqual(1);
    for (const detection of listBody.data) {
      expect(detection.orgId ?? detection.org_id).toBe(orgAId);
    }
  });

  it('should not return Org B detections after they are created', async () => {
    // Set up Org A with API key
    const adminA = await registerAdmin(app, {
      username: 'adminA',
      email: 'adminA@test.com',
      orgName: 'Org A',
    });
    const orgAId = (adminA.body.org as Record<string, unknown>).id as string;
    const userAId = (adminA.body.user as Record<string, unknown>).id as string;

    const apiKeyA = await createTestApiKey(orgAId, userAId, {
      scopes: ['api:read'],
    });

    // Query detections - should be empty initially
    const listRes1 = await appRequest(app, 'GET', '/api/detections', {
      headers: { Authorization: `Bearer ${apiKeyA.raw}` },
    });
    expect(listRes1.status).toBe(200);
    const body1 = (await listRes1.json()) as { data: unknown[] };
    expect(body1.data).toHaveLength(0);

    // Create detections in Org B (different org)
    const adminB = await registerAdmin(app, {
      username: 'adminB',
      email: 'adminB@test.com',
      orgName: 'Org B',
    });
    await appRequest(app, 'POST', '/api/detections', {
      cookie: adminB.cookie,
      body: {
        moduleId: 'github',
        name: 'Org B Only Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });

    // Query again with Org A's API key
    const listRes2 = await appRequest(app, 'GET', '/api/detections', {
      headers: { Authorization: `Bearer ${apiKeyA.raw}` },
    });
    expect(listRes2.status).toBe(200);
    const body2 = (await listRes2.json()) as { data: unknown[] };
    // Still 0 - Org B's detection must not leak
    expect(body2.data).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Login Lockout
// ═══════════════════════════════════════════════════════════════════════════

describe('Login Lockout', () => {
  it('should lock account after repeated failed login attempts', async () => {
    // Register a user through the API
    const reg = await registerAdmin(app, {
      username: 'lockme',
      email: 'lockme@test.com',
      password: 'CorrectPass123!',
      orgName: 'Lockout Org',
    });
    expect(reg.res.status).toBeLessThan(400);

    const userId = (reg.body.user as Record<string, unknown>).id as string;
    const MAX_ATTEMPTS = 5;

    // Attempt login N times with wrong password
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const result = await login(app, 'lockme', 'WrongPassword999!');
      expect(result.res.status).toBeGreaterThanOrEqual(400);
    }

    // Verify account is locked: correct password should still fail
    const correctResult = await login(app, 'lockme', 'CorrectPass123!');
    expect(correctResult.res.status).toBeGreaterThanOrEqual(400);

    // Verify lockedUntil is set in the database
    const sql = getTestSql();
    const [userRow] = await sql`
      SELECT failed_login_attempts, locked_until
      FROM users WHERE id = ${userId}
    `;
    expect(userRow.failed_login_attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
    expect(userRow.locked_until).not.toBeNull();
    // lockedUntil should be in the future
    expect(new Date(userRow.locked_until).getTime()).toBeGreaterThan(Date.now());
  });

  it('should not reset lockout on correct password attempt while locked', async () => {
    const reg = await registerAdmin(app, {
      username: 'locked2',
      email: 'locked2@test.com',
      password: 'CorrectPass123!',
      orgName: 'Lockout Org 2',
    });
    const userId = (reg.body.user as Record<string, unknown>).id as string;

    // Trigger lockout
    for (let i = 0; i < 5; i++) {
      await login(app, 'locked2', 'WrongPassword!');
    }

    // Try correct password - should still be locked
    const result1 = await login(app, 'locked2', 'CorrectPass123!');
    expect(result1.res.status).toBeGreaterThanOrEqual(400);

    // Try again - still locked
    const result2 = await login(app, 'locked2', 'CorrectPass123!');
    expect(result2.res.status).toBeGreaterThanOrEqual(400);

    // DB should still show lockout
    const sql = getTestSql();
    const [userRow] = await sql`
      SELECT locked_until FROM users WHERE id = ${userId}
    `;
    expect(userRow.locked_until).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Session Invalidation
// ═══════════════════════════════════════════════════════════════════════════

describe('Session Invalidation', () => {
  it('should return 401 after session is deleted from the DB', async () => {
    // Register and log in
    const reg = await registerAdmin(app, {
      username: 'sessuser',
      email: 'sessuser@test.com',
      orgName: 'Session Org',
    });
    expect(reg.cookie).toBeTruthy();

    // Verify session works
    const meRes1 = await appRequest(app, 'GET', '/auth/me', {
      cookie: reg.cookie,
    });
    expect(meRes1.status).toBe(200);

    // Also verify API access works
    const detectionsRes1 = await appRequest(app, 'GET', '/api/detections', {
      cookie: reg.cookie,
    });
    expect(detectionsRes1.status).toBe(200);

    // Delete all sessions from the database
    const sql = getTestSql();
    await sql`DELETE FROM sessions`;

    // Make another authenticated request with the same cookie
    const meRes2 = await appRequest(app, 'GET', '/auth/me', {
      cookie: reg.cookie,
    });
    expect(meRes2.status).toBe(401);
  });

  it('should return 401 after the specific session is deleted', async () => {
    // Register
    const reg = await registerAdmin(app, {
      username: 'sessuser2',
      email: 'sessuser2@test.com',
      orgName: 'Session Org 2',
    });
    expect(reg.cookie).toBeTruthy();

    // Extract the session ID from the cookie
    const sidMatch = reg.cookie.match(/sentinel\.sid=([^;]+)/);
    expect(sidMatch).toBeTruthy();
    const sid = sidMatch![1];

    // Delete only this specific session
    const sql = getTestSql();
    await sql`DELETE FROM sessions WHERE sid = ${sid}`;

    // Request should now fail
    const meRes = await appRequest(app, 'GET', '/auth/me', {
      cookie: reg.cookie,
    });
    expect(meRes.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. CSRF Protection
// ═══════════════════════════════════════════════════════════════════════════

describe('CSRF Protection', () => {
  it('should reject POST without X-Sentinel-Request header', async () => {
    // Register user to get a session cookie
    const reg = await registerAdmin(app, {
      username: 'csrfuser',
      email: 'csrfuser@test.com',
      orgName: 'CSRF Org',
    });

    // Make a POST request WITHOUT the X-Sentinel-Request header
    // We bypass the appRequest helper which auto-adds it, using raw app.request
    const url = 'http://localhost/api/detections';
    const res = await app.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: reg.cookie,
        // Deliberately NOT including X-Sentinel-Request
      },
      body: JSON.stringify({
        moduleId: 'github',
        name: 'CSRF Test Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    // Should contain CSRF-related error message
    const message = (body.message ?? body.error ?? '') as string;
    expect(message.toLowerCase()).toContain('csrf');
  });

  it('should accept POST with X-Sentinel-Request header', async () => {
    // Register user
    const reg = await registerAdmin(app, {
      username: 'csrfuser2',
      email: 'csrfuser2@test.com',
      orgName: 'CSRF Org 2',
    });

    // Make the same POST request WITH the X-Sentinel-Request header
    const createRes = await appRequest(app, 'POST', '/api/detections', {
      cookie: reg.cookie,
      body: {
        moduleId: 'github',
        name: 'CSRF Test Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
    });

    // Should succeed (appRequest auto-adds X-Sentinel-Request)
    expect(createRes.status).toBeLessThan(400);
  });

  it('should not require CSRF header for GET requests', async () => {
    const reg = await registerAdmin(app, {
      username: 'csrfget',
      email: 'csrfget@test.com',
      orgName: 'CSRF GET Org',
    });

    // GET requests should work without CSRF header
    const res = await app.request('http://localhost/api/detections', {
      method: 'GET',
      headers: {
        Cookie: reg.cookie,
        // No X-Sentinel-Request header
      },
    });

    expect(res.status).toBe(200);
  });

  it('should not require CSRF header for API key authenticated requests', async () => {
    const reg = await registerAdmin(app, {
      username: 'csrfapikey',
      email: 'csrfapikey@test.com',
      orgName: 'CSRF API Key Org',
    });
    const orgId = (reg.body.org as Record<string, unknown>).id as string;
    const userId = (reg.body.user as Record<string, unknown>).id as string;

    const apiKey = await createTestApiKey(orgId, userId, {
      scopes: ['api:read', 'api:write'],
    });

    // POST with API key (Bearer token) and no CSRF header
    const res = await app.request('http://localhost/api/detections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.raw}`,
        // No X-Sentinel-Request header, no Cookie
      },
      body: JSON.stringify({
        moduleId: 'github',
        name: 'API Key Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      }),
    });

    // Should succeed (CSRF check is skipped for Bearer-authenticated requests)
    expect(res.status).toBeLessThan(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Notify Key Limitations
// ═══════════════════════════════════════════════════════════════════════════

describe('Notify Key Limitations', () => {
  it('should reject notify key when reading detections', async () => {
    // Register admin and set up a notify key on the org
    const reg = await registerAdmin(app, {
      username: 'notifyadmin',
      email: 'notifyadmin@test.com',
      orgName: 'Notify Org',
    });
    const orgId = (reg.body.org as Record<string, unknown>).id as string;

    // Create a notify key by updating the org directly in the DB
    const crypto = await import('node:crypto');
    const notifyKeyRaw = `nk_${crypto.randomBytes(24).toString('base64url')}`;
    const notifyKeyHash = crypto.createHash('sha256').update(notifyKeyRaw).digest('hex');
    const notifyKeyPrefix = notifyKeyRaw.slice(0, 8);

    const sql = getTestSql();
    await sql`
      UPDATE organizations
      SET notify_key_hash = ${notifyKeyHash}, notify_key_prefix = ${notifyKeyPrefix}
      WHERE id = ${orgId}
    `;

    // Try to use notify key to read detections
    const listRes = await appRequest(app, 'GET', '/api/detections', {
      headers: {
        Authorization: `Bearer ${notifyKeyRaw}`,
      },
    });

    // Should fail - notify keys are for event ingestion only, not API access.
    // The expected behavior is either 401 (unrecognized auth) or 403 (insufficient scope).
    expect(listRes.status).toBeGreaterThanOrEqual(400);
    expect(listRes.status).toBeLessThan(500);
  });

  it('should reject notify key when creating detections', async () => {
    const reg = await registerAdmin(app, {
      username: 'notifyadmin2',
      email: 'notifyadmin2@test.com',
      orgName: 'Notify Org 2',
    });
    const orgId = (reg.body.org as Record<string, unknown>).id as string;

    const crypto = await import('node:crypto');
    const notifyKeyRaw = `nk_${crypto.randomBytes(24).toString('base64url')}`;
    const notifyKeyHash = crypto.createHash('sha256').update(notifyKeyRaw).digest('hex');
    const notifyKeyPrefix = notifyKeyRaw.slice(0, 8);

    const sql = getTestSql();
    await sql`
      UPDATE organizations
      SET notify_key_hash = ${notifyKeyHash}, notify_key_prefix = ${notifyKeyPrefix}
      WHERE id = ${orgId}
    `;

    // Try to create a detection with notify key
    const createRes = await app.request('http://localhost/api/detections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${notifyKeyRaw}`,
      },
      body: JSON.stringify({
        moduleId: 'github',
        name: 'Notify Key Detection',
        severity: 'high',
        config: {},
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      }),
    });

    // Should fail with 401 or 403
    expect(createRes.status).toBeGreaterThanOrEqual(400);
    expect(createRes.status).toBeLessThan(500);
  });

  it('should reject notify key when reading alerts', async () => {
    const reg = await registerAdmin(app, {
      username: 'notifyadmin3',
      email: 'notifyadmin3@test.com',
      orgName: 'Notify Org 3',
    });
    const orgId = (reg.body.org as Record<string, unknown>).id as string;

    const crypto = await import('node:crypto');
    const notifyKeyRaw = `nk_${crypto.randomBytes(24).toString('base64url')}`;
    const notifyKeyHash = crypto.createHash('sha256').update(notifyKeyRaw).digest('hex');
    const notifyKeyPrefix = notifyKeyRaw.slice(0, 8);

    const sql = getTestSql();
    await sql`
      UPDATE organizations
      SET notify_key_hash = ${notifyKeyHash}, notify_key_prefix = ${notifyKeyPrefix}
      WHERE id = ${orgId}
    `;

    const listRes = await appRequest(app, 'GET', '/api/alerts', {
      headers: {
        Authorization: `Bearer ${notifyKeyRaw}`,
      },
    });

    expect(listRes.status).toBeGreaterThanOrEqual(400);
    expect(listRes.status).toBeLessThan(500);
  });
});
