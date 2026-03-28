/**
 * Chunk 145 — Router: AWS (integrations CRUD, poll trigger, events)
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

describe('Chunk 145 — AWS module router', () => {
  it('should list AWS integrations for org', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const res = await appRequest(app, 'GET', '/modules/aws/integrations', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
  });

  it('should require auth for AWS endpoints', async () => {
    const res = await appRequest(app, 'GET', '/modules/aws/integrations', {});
    expect(res.status).toBe(401);
  });

  it('should list AWS events', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const res = await appRequest(app, 'GET', '/modules/aws/events', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
  });
});
