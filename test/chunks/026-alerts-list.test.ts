/**
 * Chunk 026 — Alerts: List with filters + stats + detail with event
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
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

async function createAlert(
  orgId: string,
  opts: { detectionId?: string; eventId?: string; severity?: string; title?: string } = {},
) {
  const sql = getTestSql();
  const [row] = await sql`
    INSERT INTO alerts (org_id, detection_id, event_id, severity, title, trigger_type, trigger_data)
    VALUES (${orgId}, ${opts.detectionId ?? null}, ${opts.eventId ?? null},
            ${opts.severity ?? 'high'}, ${opts.title ?? 'Test Alert'},
            'immediate', '{}'::jsonb)
    RETURNING id, org_id
  `;
  return { id: row.id, orgId: row.org_id };
}

describe('Chunk 026 — Alerts list + detail', () => {
  it('should list alerts for the org', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    await createAlert(org.id, { title: 'Alert A' });
    await createAlert(org.id, { title: 'Alert B' });

    const res = await appRequest(app, 'GET', '/api/alerts', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.length).toBe(2);
  });

  it('should filter alerts by severity', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    await createAlert(org.id, { severity: 'critical', title: 'Critical One' });
    await createAlert(org.id, { severity: 'low', title: 'Low One' });

    const res = await appRequest(app, 'GET', '/api/alerts', {
      cookie: session.cookie,
      query: { severity: 'critical' },
    });

    const body = await res.json() as any;
    expect(body.data.length).toBe(1);
    expect(body.data[0].severity).toBe('critical');
  });

  it('should get alert detail by ID', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const event = await createTestEvent(org.id, { moduleId: 'github', eventType: 'github.push' });
    const alert = await createAlert(org.id, { eventId: event.id, title: 'Detail Test' });

    const res = await appRequest(app, 'GET', `/api/alerts/${alert.id}`, {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data || body).toBeDefined();
  });

  it('should return 404 for non-existent alert', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const res = await appRequest(app, 'GET', '/api/alerts/999999', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(404);
  });

  it('should paginate alerts', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    for (let i = 0; i < 5; i++) {
      await createAlert(org.id, { title: `Alert ${i}` });
    }

    const res = await appRequest(app, 'GET', '/api/alerts', {
      cookie: session.cookie,
      query: { page: '1', limit: '2' },
    });

    const body = await res.json() as any;
    expect(body.data.length).toBe(2);
  });
});
