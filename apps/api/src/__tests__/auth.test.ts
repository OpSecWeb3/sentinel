/**
 * Integration tests for Sentinel auth routes (/auth/*).
 *
 * Covers registration, login, session management, API keys, notify keys,
 * org invite secret management, org join/leave/delete, and RBAC enforcement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { cleanTables, getTestSql } from './setup.js';
import {
  appRequest,
  extractCookie,
  registerAdmin,
  registerViewer,
  login,
  setupAdmin,
  setupAdminAndViewer,
  createApiKey,
} from './helpers.js';

let app: Hono<AppEnv>;

beforeEach(async () => {
  await cleanTables();
  // Lazily import to ensure env is configured by setup.ts
  const mod = await import('../index.js');
  app = mod.default;
});

// ===========================================================================
// Registration
// ===========================================================================

describe('POST /auth/register', () => {
  it('first user creates org, gets admin role, and returns invite secret', async () => {
    const { res, body } = await registerAdmin(app);

    expect(res.status).toBe(201);
    expect(body.user).toBeDefined();
    expect((body.user as Record<string, unknown>).username).toBe('admin');
    expect(body.org).toBeDefined();
    expect((body.org as Record<string, unknown>).slug).toBe('test-org');
    expect(body.inviteSecret).toBeDefined();
    expect(typeof body.inviteSecret).toBe('string');
    expect(extractCookie(res)).toContain('sentinel.sid=');
  });

  it('first user without orgName is rejected with 400', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'first',
        email: 'first@test.com',
        password: 'testpass123!',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('orgName');
  });

  it('second user with invite secret gets viewer role', async () => {
    const admin = await registerAdmin(app);
    const inviteSecret = admin.body.inviteSecret as string;

    const { res, body } = await registerViewer(app, inviteSecret);
    expect(res.status).toBe(201);
    expect(body.user).toBeDefined();
    expect((body.user as Record<string, unknown>).username).toBe('viewer');
    expect((body.org as Record<string, unknown>).slug).toBe('test-org');
    // Viewer registration does NOT return invite secret
    expect(body.inviteSecret).toBeUndefined();
  });

  it('second user without invite secret when org exists returns 400', async () => {
    await registerAdmin(app);
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'second',
        email: 'second@test.com',
        password: 'testpass123!',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('inviteSecret');
  });

  it('duplicate username returns 409', async () => {
    const admin = await registerAdmin(app);
    const inviteSecret = admin.body.inviteSecret as string;

    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'admin',
        email: 'different@test.com',
        password: 'testpass123!',
        inviteSecret,
      },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('already taken');
  });

  it('duplicate email returns 409', async () => {
    const admin = await registerAdmin(app);
    const inviteSecret = admin.body.inviteSecret as string;

    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'different',
        email: 'admin@test.com',
        password: 'testpass123!',
        inviteSecret,
      },
    });
    expect(res.status).toBe(409);
  });

  it('invalid invite secret returns 403', async () => {
    await registerAdmin(app);
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'joiner',
        email: 'joiner@test.com',
        password: 'testpass123!',
        inviteSecret: 'bogus-secret-value',
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Invalid invite secret');
  });

  it('rejects short username (< 3 chars)', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'ab',
        email: 'ab@test.com',
        password: 'testpass123!',
        orgName: 'Org',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects short password (< 8 chars)', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'shortpw',
        email: 'shortpw@test.com',
        password: 'short',
        orgName: 'Org',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid email', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'bademail',
        email: 'not-an-email',
        password: 'testpass123!',
        orgName: 'Org',
      },
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Login
// ===========================================================================

describe('POST /auth/login', () => {
  it('login with username sets session cookie', async () => {
    await registerAdmin(app);

    const { res, body } = await login(app, 'admin', 'testpass123!');
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect((body.user as Record<string, unknown>).role).toBe('admin');
    expect(extractCookie(res)).toContain('sentinel.sid=');
  });

  it('login with email works', async () => {
    await registerAdmin(app);

    const { res, body } = await login(app, 'admin@test.com', 'testpass123!');
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('wrong password returns 401', async () => {
    await registerAdmin(app);

    const { res } = await login(app, 'admin', 'wrongpassword!');
    expect(res.status).toBe(401);
  });

  it('non-existent user returns 401', async () => {
    const { res } = await login(app, 'ghost', 'testpass123!');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// GET /auth/me
// ===========================================================================

describe('GET /auth/me', () => {
  it('returns user info with session cookie', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/auth/me', { cookie: admin.cookie });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(body.user.userId).toBe(admin.userId);
    expect(body.user.orgId).toBe(admin.orgId);
    expect(body.user.role).toBe('admin');
    expect(body.needsOrg).toBe(false);
  });

  it('returns apiKey info when using API key auth', async () => {
    const admin = await setupAdmin(app);
    const { key } = await createApiKey(app, admin.cookie, 'test-key', ['api:read', 'api:write']);

    const res = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.apiKey).toBeDefined();
    expect(body.apiKey.scopes).toContain('api:read');
    expect(body.apiKey.scopes).toContain('api:write');
  });

  it('unauthenticated request returns 401', async () => {
    const res = await appRequest(app, 'GET', '/auth/me');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// POST /auth/logout
// ===========================================================================

describe('POST /auth/logout', () => {
  it('destroys session so subsequent /me returns 401', async () => {
    const admin = await setupAdmin(app);

    // Logout
    const logoutRes = await appRequest(app, 'POST', '/auth/logout', { cookie: admin.cookie });
    expect(logoutRes.status).toBe(200);

    // Session should be invalid now
    const meRes = await appRequest(app, 'GET', '/auth/me', { cookie: admin.cookie });
    expect(meRes.status).toBe(401);
  });
});

// ===========================================================================
// API Key CRUD
// ===========================================================================

describe('API Key management', () => {
  it('create API key returns raw key once with warning', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/auth/api-keys', {
      cookie: admin.cookie,
      body: { name: 'my-key', scopes: ['api:read'] },
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.key).toMatch(/^sk_/);
    expect(body.name).toBe('my-key');
    expect(body.prefix).toMatch(/^sk_/);
    expect(body.warning).toBeDefined();
  });

  it('list API keys does not expose raw key', async () => {
    const admin = await setupAdmin(app);
    await createApiKey(app, admin.cookie, 'my-key');

    const res = await appRequest(app, 'GET', '/auth/api-keys', { cookie: admin.cookie });
    expect(res.status).toBe(200);

    const keys = await res.json();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const key = keys.find((k: Record<string, unknown>) => k.name === 'my-key');
    expect(key).toBeDefined();
    expect(key.keyPrefix).toMatch(/^sk_/);
    expect(key.key).toBeUndefined();
    expect(key.keyHash).toBeUndefined();
  });

  it('revoke API key marks it as revoked', async () => {
    const admin = await setupAdmin(app);
    const { key, id } = await createApiKey(app, admin.cookie, 'to-revoke');

    // Revoke
    const revokeRes = await appRequest(app, 'DELETE', `/auth/api-keys/${id}`, {
      cookie: admin.cookie,
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = await revokeRes.json();
    expect(revokeBody.status).toBe('revoked');

    // Revoked key no longer authenticates
    const meRes = await appRequest(app, 'GET', '/auth/me', {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(meRes.status).toBe(401);
  });

  it('revoke non-existent key returns 404', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'DELETE', '/auth/api-keys/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('create key with expiry', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/auth/api-keys', {
      cookie: admin.cookie,
      body: { name: 'expiring-key', scopes: ['api:read'], expiresInDays: 30 },
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.expiresAt).toBeDefined();
    const expiresAt = new Date(body.expiresAt);
    const now = new Date();
    // Should expire roughly 30 days from now
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });
});

// ===========================================================================
// Notify Key lifecycle
// ===========================================================================

describe('Notify key management', () => {
  it('full lifecycle: status -> generate -> status -> rotate -> revoke', async () => {
    const admin = await setupAdmin(app);

    // Initially no key
    const statusRes1 = await appRequest(app, 'GET', '/auth/org/notify-key/status', {
      cookie: admin.cookie,
    });
    expect(statusRes1.status).toBe(200);
    const status1 = await statusRes1.json();
    expect(status1.exists).toBe(false);

    // Generate
    const genRes = await appRequest(app, 'POST', '/auth/org/notify-key/generate', {
      cookie: admin.cookie,
    });
    expect(genRes.status).toBe(201);
    const genBody = await genRes.json();
    expect(genBody.key).toMatch(/^snk_/);
    expect(genBody.prefix).toMatch(/^snk_/);
    expect(genBody.warning).toBeDefined();

    // Status shows it exists
    const statusRes2 = await appRequest(app, 'GET', '/auth/org/notify-key/status', {
      cookie: admin.cookie,
    });
    const status2 = await statusRes2.json();
    expect(status2.exists).toBe(true);
    expect(status2.prefix).toMatch(/^snk_/);

    // Cannot generate again (must rotate)
    const dupRes = await appRequest(app, 'POST', '/auth/org/notify-key/generate', {
      cookie: admin.cookie,
    });
    expect(dupRes.status).toBe(409);

    // Rotate: new key replaces old
    const rotateRes = await appRequest(app, 'POST', '/auth/org/notify-key/rotate', {
      cookie: admin.cookie,
    });
    expect(rotateRes.status).toBe(201);
    const rotateBody = await rotateRes.json();
    expect(rotateBody.key).toMatch(/^snk_/);
    expect(rotateBody.key).not.toBe(genBody.key);

    // Revoke
    const revokeRes = await appRequest(app, 'DELETE', '/auth/org/notify-key', {
      cookie: admin.cookie,
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = await revokeRes.json();
    expect(revokeBody.status).toBe('revoked');

    // Status shows gone
    const statusRes3 = await appRequest(app, 'GET', '/auth/org/notify-key/status', {
      cookie: admin.cookie,
    });
    const status3 = await statusRes3.json();
    expect(status3.exists).toBe(false);
  });
});

// ===========================================================================
// Org invite secret management
// ===========================================================================

describe('Org invite secret (admin only)', () => {
  it('admin can view invite secret', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/auth/org/invite-secret', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inviteSecret).toBe(admin.inviteSecret);
  });

  it('admin can regenerate invite secret (old one becomes invalid)', async () => {
    const admin = await setupAdmin(app);
    const oldSecret = admin.inviteSecret;

    // Regenerate
    const regenRes = await appRequest(app, 'POST', '/auth/org/invite-secret/regenerate', {
      cookie: admin.cookie,
    });
    expect(regenRes.status).toBe(200);
    const regenBody = await regenRes.json();
    expect(regenBody.inviteSecret).toBeDefined();
    expect(regenBody.inviteSecret).not.toBe(oldSecret);

    // Old secret no longer works
    const badReg = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'latecomer',
        email: 'latecomer@test.com',
        password: 'testpass123!',
        inviteSecret: oldSecret,
      },
    });
    expect(badReg.status).toBe(403);

    // New secret works
    const goodReg = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'newcomer',
        email: 'newcomer@test.com',
        password: 'testpass123!',
        inviteSecret: regenBody.inviteSecret,
      },
    });
    expect(goodReg.status).toBe(201);
  });

  it('viewer cannot view invite secret (403)', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);

    const res = await appRequest(app, 'GET', '/auth/org/invite-secret', {
      cookie: viewer.cookie,
    });
    expect(res.status).toBe(403);
  });

  it('viewer cannot regenerate invite secret (403)', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);

    const res = await appRequest(app, 'POST', '/auth/org/invite-secret/regenerate', {
      cookie: viewer.cookie,
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Org join / leave / delete
// ===========================================================================

describe('Org join/leave/delete', () => {
  it('org-less user can join via invite secret', async () => {
    const admin = await setupAdmin(app);

    // Register a viewer, then remove their membership via DB
    const viewerReg = await registerViewer(app, admin.inviteSecret);
    const viewerUserId = (viewerReg.body.user as Record<string, unknown>).id as string;
    const sql = getTestSql();
    await sql`DELETE FROM org_memberships WHERE user_id = ${viewerUserId}`;

    // Re-login to get a fresh session without org
    const { cookie: orphanCookie } = await login(app, 'viewer', 'testpass123!');

    // Join
    const joinRes = await appRequest(app, 'POST', '/auth/org/join', {
      cookie: orphanCookie,
      body: { inviteSecret: admin.inviteSecret },
    });
    expect(joinRes.status).toBe(200);
    const joinBody = await joinRes.json();
    expect(joinBody.status).toBe('joined');
    expect(joinBody.org.slug).toBe('test-org');
  });

  it('user already in org cannot join another (400)', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/auth/org/join', {
      cookie: admin.cookie,
      body: { inviteSecret: 'anything' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already belong');
  });

  it('viewer can leave org', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);

    // Viewer needs to login to get a fresh session with orgId
    const { cookie: viewerCookie } = await login(app, 'viewer', 'testpass123!');

    const leaveRes = await appRequest(app, 'POST', '/auth/org/leave', {
      cookie: viewerCookie,
    });
    expect(leaveRes.status).toBe(200);
    const body = await leaveRes.json();
    expect(body.status).toBe('left');
  });

  it('sole admin cannot leave org', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/auth/org/leave', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('only admin');
  });

  it('admin with another admin can leave', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);

    // Promote viewer to admin
    await appRequest(app, 'PATCH', `/auth/users/${viewer.userId}/role`, {
      cookie: admin.cookie,
      body: { role: 'admin' },
    });

    // Now first admin can leave
    const leaveRes = await appRequest(app, 'POST', '/auth/org/leave', {
      cookie: admin.cookie,
    });
    expect(leaveRes.status).toBe(200);
  });

  it('admin can delete org', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'DELETE', '/auth/org', {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('deleted');
    expect(body.org.slug).toBe('test-org');

    // Verify org is gone
    const sql = getTestSql();
    const [row] = await sql`SELECT id FROM organizations WHERE id = ${admin.orgId}`;
    expect(row).toBeUndefined();
  });

  it('viewer cannot delete org (403)', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);
    const { cookie: viewerCookie } = await login(app, 'viewer', 'testpass123!');

    const res = await appRequest(app, 'DELETE', '/auth/org', {
      cookie: viewerCookie,
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// User management (admin only)
// ===========================================================================

describe('User management', () => {
  it('admin can list org members', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);

    const res = await appRequest(app, 'GET', '/auth/users', { cookie: admin.cookie });
    expect(res.status).toBe(200);

    const members = await res.json();
    expect(Array.isArray(members)).toBe(true);
    expect(members.length).toBe(2);
    const usernames = members.map((m: Record<string, unknown>) => m.username);
    expect(usernames).toContain('admin');
    expect(usernames).toContain('viewer');
  });

  it('admin can change user role', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);

    const res = await appRequest(app, 'PATCH', `/auth/users/${viewer.userId}/role`, {
      cookie: admin.cookie,
      body: { role: 'editor' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe('editor');
  });

  it('viewer cannot access admin-only users endpoint (403)', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);
    const { cookie: viewerCookie } = await login(app, 'viewer', 'testpass123!');

    const res = await appRequest(app, 'GET', '/auth/users', { cookie: viewerCookie });
    expect(res.status).toBe(403);
  });

  it('viewer cannot change roles (403)', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);
    const { cookie: viewerCookie } = await login(app, 'viewer', 'testpass123!');

    const res = await appRequest(app, 'PATCH', `/auth/users/${admin.userId}/role`, {
      cookie: viewerCookie,
      body: { role: 'viewer' },
    });
    expect(res.status).toBe(403);
  });

  it('change role for non-existent user returns 404', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'PATCH', '/auth/users/00000000-0000-0000-0000-000000000000/role', {
      cookie: admin.cookie,
      body: { role: 'editor' },
    });
    expect(res.status).toBe(404);
  });

  it('invalid role value is rejected', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);

    const res = await appRequest(app, 'PATCH', `/auth/users/${viewer.userId}/role`, {
      cookie: admin.cookie,
      body: { role: 'superadmin' },
    });
    // Zod parse will throw, caught by the error handler
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// Viewer cannot access admin endpoints
// ===========================================================================

describe('RBAC enforcement', () => {
  it('viewer cannot access notify key endpoints', async () => {
    const { admin, viewer } = await setupAdminAndViewer(app);
    const { cookie: viewerCookie } = await login(app, 'viewer', 'testpass123!');

    const endpoints = [
      { method: 'GET', path: '/auth/org/notify-key/status' },
      { method: 'POST', path: '/auth/org/notify-key/generate' },
      { method: 'POST', path: '/auth/org/notify-key/rotate' },
      { method: 'DELETE', path: '/auth/org/notify-key' },
    ];

    for (const ep of endpoints) {
      const res = await appRequest(app, ep.method, ep.path, { cookie: viewerCookie });
      expect(res.status).toBe(403);
    }
  });

  it('unauthenticated request to /auth/me returns 401', async () => {
    const res = await appRequest(app, 'GET', '/auth/me');
    expect(res.status).toBe(401);
  });
});
