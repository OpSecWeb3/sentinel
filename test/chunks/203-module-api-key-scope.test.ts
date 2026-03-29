import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import { getApp, appRequest } from '../../apps/api/src/__tests__/helpers.js';
import {
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestApiKey,
} from '../helpers/setup.js';

let app: Hono<any>;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
});

describe('Chunk 203 — module API key scope enforcement', () => {
  it('rejects module write routes for api:read keys', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const apiKey = await createTestApiKey(org.id, user.id, { scopes: ['api:read'] });

    const res = await appRequest(app, 'POST', '/modules/registry/images', {
      headers: { Authorization: `Bearer ${apiKey.raw}` },
      body: {
        name: `scope-test-${Date.now()}`,
        tagPatterns: ['release-*'],
        ignorePatterns: [],
        pollIntervalSeconds: 300,
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('Scope "api:write" required');
  });

  it('allows module read routes for api:read keys', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const apiKey = await createTestApiKey(org.id, user.id, { scopes: ['api:read'] });

    const res = await appRequest(app, 'GET', '/modules/registry/images', {
      headers: { Authorization: `Bearer ${apiKey.raw}` },
    });

    expect(res.status).toBe(200);
  });
});
