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

  it('should reject viewer creating chain detection', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'viewer');
    const session = await createTestSession(user.id, org.id, 'viewer');

    const res = await appRequest(app, 'POST', '/modules/chain/detections', {
      cookie: session.cookie,
      body: { name: 'test', templateSlug: 'large-transfer' },
    });

    expect(res.status).toBe(403);
  });

  it('should reject viewer updating chain detection', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'viewer');
    const session = await createTestSession(user.id, org.id, 'viewer');

    const res = await appRequest(app, 'PATCH', '/modules/chain/detections/fake-id', {
      cookie: session.cookie,
      body: { name: 'updated' },
    });

    expect(res.status).toBe(403);
  });

  it('should reject viewer deleting chain detection', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'viewer');
    const session = await createTestSession(user.id, org.id, 'viewer');

    const res = await appRequest(app, 'DELETE', '/modules/chain/detections/fake-id', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(403);
  });

  it('should allow editor to update but not delete chain detection', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'editor');
    const session = await createTestSession(user.id, org.id, 'editor');

    const patchRes = await appRequest(app, 'PATCH', '/modules/chain/detections/fake-id', {
      cookie: session.cookie,
      body: { name: 'updated' },
    });
    // Editor can reach the handler (won't be 403, may be 400/404 due to fake id)
    expect(patchRes.status).not.toBe(403);

    const deleteRes = await appRequest(app, 'DELETE', '/modules/chain/detections/fake-id', {
      cookie: session.cookie,
    });
    expect(deleteRes.status).toBe(403);
  });
});
