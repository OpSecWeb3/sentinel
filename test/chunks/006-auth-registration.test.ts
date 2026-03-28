/**
 * Chunk 006 — Auth: First-user registration + org creation + invite secret returned
 *
 * Validates that the first user bootstraps the system by creating an org,
 * becomes admin, and receives a raw invite secret.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters, getTestSql } from '../helpers/setup.js';
import {
  getApp,
  appRequest,
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

describe('Chunk 006 — First-user registration + org creation', () => {
  it('should create org, admin membership, and return invite secret on first registration', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'firstadmin',
        email: 'first@test.com',
        password: 'StrongPass1!',
        orgName: 'My Org',
      },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;

    // Should return user, org, and invite secret
    expect(body.user).toBeDefined();
    expect(body.user.username).toBe('firstadmin');
    expect(body.org).toBeDefined();
    expect(body.org.name).toBe('My Org');
    expect(body.org.slug).toBe('my-org');
    expect(body.inviteSecret).toBeDefined();
    expect(typeof body.inviteSecret).toBe('string');
    expect(body.inviteSecret.length).toBeGreaterThan(10);

    // Should set session cookie
    const cookie = extractCookie(res);
    expect(cookie).toContain('sentinel.sid=');
  });

  it('should require orgName for the very first user', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'firstadmin',
        email: 'first@test.com',
        password: 'StrongPass1!',
        // no orgName
      },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/orgName required/i);
  });

  it('should create the org with a valid slug from orgName', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'admin1',
        email: 'admin1@test.com',
        password: 'StrongPass1!',
        orgName: 'My  Great  Org!',
      },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.org.slug).toBe('my-great-org');
  });

  it('should reject duplicate username on registration', async () => {
    // Register first user
    await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'admin1',
        email: 'admin1@test.com',
        password: 'StrongPass1!',
        orgName: 'Org A',
      },
    });

    // Try again with same username
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'admin1',
        email: 'different@test.com',
        password: 'StrongPass1!',
        inviteSecret: 'anything',
      },
    });

    expect(res.status).toBe(409);
  });

  it('should reject duplicate email on registration', async () => {
    await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'admin1',
        email: 'same@test.com',
        password: 'StrongPass1!',
        orgName: 'Org A',
      },
    });

    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'different',
        email: 'same@test.com',
        password: 'StrongPass1!',
        inviteSecret: 'anything',
      },
    });

    expect(res.status).toBe(409);
  });

  it('should validate username format (alphanumeric, underscore, dash)', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'bad user name!',
        email: 'test@test.com',
        password: 'StrongPass1!',
        orgName: 'Org',
      },
    });

    expect(res.status).toBe(400);
  });

  it('should validate password minimum length', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'testuser',
        email: 'test@test.com',
        password: 'short',
        orgName: 'Org',
      },
    });

    expect(res.status).toBe(400);
  });

  it('should store invite secret hash (not plaintext) in DB', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'admin1',
        email: 'admin1@test.com',
        password: 'StrongPass1!',
        orgName: 'Hash Org',
      },
    });
    const body = await res.json() as any;

    const sql = getTestSql();
    const [org] = await sql`SELECT invite_secret_hash, invite_secret_encrypted FROM organizations WHERE id = ${body.org.id}`;

    // Hash and encrypted columns should be set
    expect(org.invite_secret_hash).toBeDefined();
    expect(org.invite_secret_hash).not.toBe(body.inviteSecret);
    expect(org.invite_secret_encrypted).toBeDefined();
  });

  it('should grant admin role to the first user', async () => {
    const res = await appRequest(app, 'POST', '/auth/register', {
      body: {
        username: 'admin1',
        email: 'admin1@test.com',
        password: 'StrongPass1!',
        orgName: 'Admin Org',
      },
    });
    const cookie = extractCookie(res);

    // Verify via /auth/me
    const meRes = await appRequest(app, 'GET', '/auth/me', { cookie });
    expect(meRes.status).toBe(200);
    const me = await meRes.json() as any;
    expect(me.user.role).toBe('admin');
  });
});
