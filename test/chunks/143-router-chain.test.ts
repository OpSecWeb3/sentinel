/**
 * Chunk 143 — Router: Chain (contracts CRUD, verify, networks, RPC configs, events)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
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

describe('Chunk 143 — Chain module router', () => {
  it('should list chain networks', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const res = await appRequest(app, 'GET', '/modules/chain/networks', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
  });

  it('should list contracts for org', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const res = await appRequest(app, 'GET', '/modules/chain/contracts', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
  });

  it('should require auth for chain module endpoints', async () => {
    const res = await appRequest(app, 'GET', '/modules/chain/contracts', {});
    expect(res.status).toBe(401);
  });
});
