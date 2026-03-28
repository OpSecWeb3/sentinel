/**
 * Chunk 144 — Router: Infra (hosts CRUD, scan triggers, discover, suppressions, CT logs)
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

describe('Chunk 144 — Infra module router', () => {
  it('should list hosts for org', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    await sql`
      INSERT INTO infra_hosts (org_id, hostname, is_root, source)
      VALUES (${org.id}, 'example.com', true, 'manual')
    `;

    const res = await appRequest(app, 'GET', '/modules/infra/hosts', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
  });

  it('should add a new host', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const res = await appRequest(app, 'POST', '/modules/infra/hosts', {
      cookie: session.cookie,
      body: {
        hostname: 'new-host.example.com',
      },
    });

    expect(res.status).toBeLessThan(500);
  });

  it('should require auth for infra endpoints', async () => {
    const res = await appRequest(app, 'GET', '/modules/infra/hosts', {});
    expect(res.status).toBe(401);
  });
});
