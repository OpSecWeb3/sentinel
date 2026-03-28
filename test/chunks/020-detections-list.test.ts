/**
 * Chunk 020 — Detections: List with filters (moduleId, status, severity, search, pagination)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters } from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  setupAdmin,
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

/** Helper: create a detection */
async function createDetection(cookie: string, overrides: Record<string, unknown> = {}) {
  return appRequest(app, 'POST', '/api/detections', {
    cookie,
    body: {
      moduleId: 'github',
      name: 'Test Detection',
      severity: 'high',
      rules: [{ ruleType: 'github.repo_visibility', config: {}, action: 'alert' }],
      ...overrides,
    },
  });
}

describe('Chunk 020 — List detections with filters', () => {
  it('should list detections for the org', async () => {
    const admin = await setupAdmin(app);
    await createDetection(admin.cookie, { name: 'Detection A' });
    await createDetection(admin.cookie, { name: 'Detection B' });

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('should filter by moduleId', async () => {
    const admin = await setupAdmin(app);
    await createDetection(admin.cookie, { name: 'GitHub 1', moduleId: 'github' });
    await createDetection(admin.cookie, { name: 'Registry 1', moduleId: 'registry' });

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { moduleId: 'github' },
    });

    const body = await res.json() as any;
    expect(body.data.length).toBe(1);
    expect(body.data[0].moduleId).toBe('github');
  });

  it('should filter by severity', async () => {
    const admin = await setupAdmin(app);
    await createDetection(admin.cookie, { name: 'High', severity: 'high' });
    await createDetection(admin.cookie, { name: 'Low', severity: 'low' });

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { severity: 'low' },
    });

    const body = await res.json() as any;
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('Low');
  });

  it('should search by name (case-insensitive)', async () => {
    const admin = await setupAdmin(app);
    await createDetection(admin.cookie, { name: 'Alpha Visibility' });
    await createDetection(admin.cookie, { name: 'Beta Branch Protection' });

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { search: 'visibility' },
    });

    const body = await res.json() as any;
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toContain('Visibility');
  });

  it('should paginate results', async () => {
    const admin = await setupAdmin(app);
    for (let i = 0; i < 5; i++) {
      await createDetection(admin.cookie, { name: `Detection ${i}` });
    }

    const page1 = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { page: '1', limit: '2' },
    });
    const body1 = await page1.json() as any;
    expect(body1.data.length).toBe(2);
    expect(body1.total).toBe(5);

    const page2 = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { page: '2', limit: '2' },
    });
    const body2 = await page2.json() as any;
    expect(body2.data.length).toBe(2);
  });

  it('should return empty array when no matches', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
      query: { moduleId: 'nonexistent' },
    });

    const body = await res.json() as any;
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });
});
