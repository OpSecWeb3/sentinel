/**
 * Chunk 027 — Events: List with filters (moduleId, eventType, search, dateRange, pagination)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestEvent,
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

describe('Chunk 027 — Events list with filters', () => {
  it('should list events for the org', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    await createTestEvent(org.id, { moduleId: 'github', eventType: 'github.push' });
    await createTestEvent(org.id, { moduleId: 'github', eventType: 'github.pull_request' });

    const res = await appRequest(app, 'GET', '/api/events', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBe(2);
  });

  it('should filter by moduleId', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    await createTestEvent(org.id, { moduleId: 'github', eventType: 'github.push' });
    await createTestEvent(org.id, { moduleId: 'registry', eventType: 'registry.publish' });

    const res = await appRequest(app, 'GET', '/api/events', {
      cookie: session.cookie,
      query: { moduleId: 'github' },
    });

    const body = await res.json() as any;
    expect(body.data.length).toBe(1);
    expect(body.data[0].moduleId).toBe('github');
  });

  it('should filter by eventType', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    await createTestEvent(org.id, { eventType: 'github.push' });
    await createTestEvent(org.id, { eventType: 'github.pull_request' });

    const res = await appRequest(app, 'GET', '/api/events', {
      cookie: session.cookie,
      query: { eventType: 'github.push' },
    });

    const body = await res.json() as any;
    expect(body.data.length).toBe(1);
  });

  it('should paginate events', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    for (let i = 0; i < 5; i++) {
      await createTestEvent(org.id, { eventType: `github.event_${i}` });
    }

    const res = await appRequest(app, 'GET', '/api/events', {
      cookie: session.cookie,
      query: { page: '1', limit: '2' },
    });

    const body = await res.json() as any;
    expect(body.data.length).toBe(2);
    expect(body.meta.total).toBe(5);
  });

  it('should return empty array when no events match', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const res = await appRequest(app, 'GET', '/api/events', {
      cookie: session.cookie,
      query: { moduleId: 'nonexistent' },
    });

    const body = await res.json() as any;
    expect(body.data).toEqual([]);
  });
});
