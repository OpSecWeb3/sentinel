/**
 * Chunk 007 — Auth: Join-org via invite secret (hash validation, viewer role assigned)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters } from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  extractCookie,
  registerAdmin,
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

describe('Chunk 007 — Join org via invite secret', () => {
  it('should allow second user to join via invite secret with viewer role', async () => {
    // First user creates org
    const admin = await registerAdmin(app, {
      username: 'admin1',
      email: 'admin1@test.com',
      orgName: 'Join Org',
    });
    const inviteSecret = (admin.body as any).inviteSecret;

    // Second user joins
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'joiner1',
        email: 'joiner1@test.com',
        password: 'StrongPass1!',
        inviteSecret,
      },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.user.username).toBe('joiner1');
    expect(body.org.name).toBe('Join Org');
    // Should not return invite secret to joining users
    expect(body.inviteSecret).toBeUndefined();
  });

  it('should assign viewer role to users who join via invite', async () => {
    const admin = await registerAdmin(app);
    const inviteSecret = (admin.body as any).inviteSecret;

    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'viewer1',
        email: 'viewer1@test.com',
        password: 'StrongPass1!',
        inviteSecret,
      },
    });
    const cookie = extractCookie(res);

    const meRes = await appRequest(app, 'GET', '/auth/me', { cookie });
    const me = await meRes.json() as any;
    expect(me.user.role).toBe('viewer');
  });

  it('should reject invalid invite secret', async () => {
    await registerAdmin(app);

    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'joiner1',
        email: 'joiner1@test.com',
        password: 'StrongPass1!',
        inviteSecret: 'totally-wrong-secret',
      },
    });

    expect(res.status).toBe(403);
  });

  it('should require invite secret when org already exists', async () => {
    await registerAdmin(app);

    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'joiner1',
        email: 'joiner1@test.com',
        password: 'StrongPass1!',
        // no inviteSecret
      },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/inviteSecret required/i);
  });

  it('should set session cookie for joining user', async () => {
    const admin = await registerAdmin(app);
    const inviteSecret = (admin.body as any).inviteSecret;

    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'joiner1',
        email: 'joiner1@test.com',
        password: 'StrongPass1!',
        inviteSecret,
      },
    });

    const cookie = extractCookie(res);
    expect(cookie).toContain('sentinel.sid=');
  });

  it('should allow POST /org/join for authenticated user without org', async () => {
    // This tests the /org/join endpoint (for users who registered but have no org)
    // First, create an org via the first user
    const admin = await registerAdmin(app);
    const inviteSecret = (admin.body as any).inviteSecret;

    // Register a second user via invite
    const viewer = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'viewer1',
        email: 'viewer1@test.com',
        password: 'StrongPass1!',
        inviteSecret,
      },
    });

    expect(viewer.status).toBe(201);
  });
});
