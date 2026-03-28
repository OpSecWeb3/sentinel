/**
 * Chunk 021 — Detections: Update (status toggle pauses/resumes rules, rule replacement)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanTables, resetCounters, getTestSql } from '../helpers/setup.js';
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

async function createDetection(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await appRequest(app, 'POST', '/api/detections', {
    cookie,
    body: {
      moduleId: 'github',
      name: 'Test Detection',
      severity: 'high',
      rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      ...overrides,
    },
  });
  return res.json() as Promise<any>;
}

describe('Chunk 021 — Update detections', () => {
  it('should update detection name', async () => {
    const admin = await setupAdmin(app);
    const created = await createDetection(admin.cookie);
    const id = created.data.detection.id;

    const res = await appRequest(app, 'PATCH', `/api/detections/${id}`, {
      cookie: admin.cookie,
      body: { name: 'Updated Name' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe('Updated Name');
  });

  it('should pause a detection (status → paused)', async () => {
    const admin = await setupAdmin(app);
    const created = await createDetection(admin.cookie);
    const id = created.data.detection.id;

    const res = await appRequest(app, 'PATCH', `/api/detections/${id}`, {
      cookie: admin.cookie,
      body: { status: 'paused' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('paused');
  });

  it('should resume a paused detection (status → active)', async () => {
    const admin = await setupAdmin(app);
    const created = await createDetection(admin.cookie);
    const id = created.data.detection.id;

    // Pause
    await appRequest(app, 'PATCH', `/api/detections/${id}`, {
      cookie: admin.cookie,
      body: { status: 'paused' },
    });

    // Resume
    const res = await appRequest(app, 'PATCH', `/api/detections/${id}`, {
      cookie: admin.cookie,
      body: { status: 'active' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('active');
  });

  it('should update severity', async () => {
    const admin = await setupAdmin(app);
    const created = await createDetection(admin.cookie);
    const id = created.data.detection.id;

    const res = await appRequest(app, 'PATCH', `/api/detections/${id}`, {
      cookie: admin.cookie,
      body: { severity: 'critical' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.severity).toBe('critical');
  });

  it('should replace rules when rules array provided', async () => {
    const admin = await setupAdmin(app);
    const created = await createDetection(admin.cookie);
    const id = created.data.detection.id;

    const res = await appRequest(app, 'PATCH', `/api/detections/${id}`, {
      cookie: admin.cookie,
      body: {
        rules: [
          { ruleType: 'github.branch_protection', config: { watchBranches: ['main'] }, action: 'alert' },
          { ruleType: 'github.member_change', config: {}, action: 'log' },
        ],
      },
    });

    expect(res.status).toBe(200);
    const getRes = await appRequest(app, 'GET', `/api/detections/${id}`, {
      cookie: admin.cookie,
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as any;
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.rules.map((r: any) => r.ruleType)).toContain('github.branch_protection');
  });

  it('should reject empty update body', async () => {
    const admin = await setupAdmin(app);
    const created = await createDetection(admin.cookie);
    const id = created.data.detection.id;

    const res = await appRequest(app, 'PATCH', `/api/detections/${id}`, {
      cookie: admin.cookie,
      body: {},
    });

    expect(res.status).toBe(400);
  });

  it('should return 404 for non-existent detection', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'PATCH', '/api/detections/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
      body: { name: 'Ghost' },
    });

    expect(res.status).toBe(404);
  });
});
