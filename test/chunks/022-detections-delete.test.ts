/**
 * Chunk 022 — Detections: Delete/archive (soft delete, cascade to rules)
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

async function createDetection(cookie: string, name = 'Test Detection') {
  const res = await appRequest(app, 'POST', '/api/detections', {
    cookie,
    body: {
      moduleId: 'github',
      name,
      severity: 'high',
      rules: [{ ruleType: 'github.repo_visibility', config: {}, action: 'alert' }],
    },
  });
  return res.json() as Promise<any>;
}

describe('Chunk 022 — Delete detections', () => {
  it('should delete a detection', async () => {
    const admin = await setupAdmin(app);
    const created = await createDetection(admin.cookie);
    const id = created.data.detection.id;

    const res = await appRequest(app, 'DELETE', `/api/detections/${id}`, {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(200);
  });

  it('should cascade delete rules when detection is deleted', async () => {
    const admin = await setupAdmin(app);
    const created = await createDetection(admin.cookie);
    const id = created.data.detection.id;

    await appRequest(app, 'DELETE', `/api/detections/${id}`, {
      cookie: admin.cookie,
    });

    // Rules should be gone
    const sql = getTestSql();
    const remaining = await sql`SELECT count(*) as count FROM rules WHERE detection_id = ${id}`;
    expect(Number(remaining[0].count)).toBe(0);
  });

  it('should not list deleted detection', async () => {
    const admin = await setupAdmin(app);
    await createDetection(admin.cookie, 'Keep Me');
    const deleted = await createDetection(admin.cookie, 'Delete Me');

    await appRequest(app, 'DELETE', `/api/detections/${deleted.data.detection.id}`, {
      cookie: admin.cookie,
    });

    const listRes = await appRequest(app, 'GET', '/api/detections', {
      cookie: admin.cookie,
    });
    const body = await listRes.json() as any;
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('Keep Me');
  });

  it('should return 404 when deleting non-existent detection', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'DELETE', '/api/detections/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(404);
  });
});
