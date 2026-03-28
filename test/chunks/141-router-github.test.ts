/**
 * Chunk 141 — Router: GitHub (OAuth flow, webhook endpoint, installations CRUD, repo sync)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestSession,
  createTestGithubInstallation,
  createTestGithubRepo,
} from '../helpers/setup.js';
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

describe('Chunk 141 — GitHub module router', () => {
  it('should list GitHub installations for org', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    await createTestGithubInstallation(org.id, {
      installationId: 12345,
      targetLogin: 'test-org',
    });

    const res = await appRequest(app, 'GET', '/modules/github/installations', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.data || body)).toBe(true);
  });

  it('should list repos for an installation', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const install = await createTestGithubInstallation(org.id, { installationId: 12345 });
    await createTestGithubRepo(org.id, install.id, {
      fullName: 'org/repo-a',
      visibility: 'private',
    });

    const res = await appRequest(app, 'GET', `/modules/github/installations/${install.id}/repos`, {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
  });

  it('should require auth for installation endpoints', async () => {
    const res = await appRequest(app, 'GET', '/modules/github/installations', {});
    expect(res.status).toBe(401);
  });
});
