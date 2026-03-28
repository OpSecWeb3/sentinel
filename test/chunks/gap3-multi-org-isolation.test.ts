/**
 * Audit Gap 3 — Multi-org isolation tests
 *
 * Every GET /resource endpoint gets a two-org test verifying that org B
 * cannot see org A's data. These catch cross-tenant data leakage bugs
 * in SQL WHERE clauses, subqueries, and analytics aggregations.
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
  createTestDetection,
  createTestRule,
  createTestEvent,
  createTestNotificationChannel,
  createTestArtifact,
  createTestGithubInstallation,
  createTestGithubRepo,
} from '../helpers/setup.js';
import { getApp, appRequest } from '../../apps/api/src/__tests__/helpers.js';
import type { Hono } from 'hono';

let app: Hono<any>;

interface OrgFixture {
  userId: string;
  orgId: string;
  cookie: string;
}

let orgA: OrgFixture;
let orgB: OrgFixture;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();

  // Create two completely separate orgs with their own admins
  const userA = await createTestUser({ username: 'adminA', email: 'a@test.com' });
  const oA = await createTestOrg({ name: 'Org A', slug: 'org-a' });
  await addMembership(oA.id, userA.id, 'admin');
  const sessA = await createTestSession(userA.id, oA.id, 'admin');
  orgA = { userId: userA.id, orgId: oA.id, cookie: sessA.cookie };

  const userB = await createTestUser({ username: 'adminB', email: 'b@test.com' });
  const oB = await createTestOrg({ name: 'Org B', slug: 'org-b' });
  await addMembership(oB.id, userB.id, 'admin');
  const sessB = await createTestSession(userB.id, oB.id, 'admin');
  orgB = { userId: userB.id, orgId: oB.id, cookie: sessB.cookie };
});

describe('Gap 3 — Multi-org data isolation', () => {
  describe('Detections', () => {
    it('org B cannot see org A detections', async () => {
      await createTestDetection(orgA.orgId, orgA.userId, { name: 'Secret Detection A' });

      const res = await appRequest(app, 'GET', '/api/detections', {
        cookie: orgB.cookie,
      });
      const body = await res.json() as any;
      expect(body.data).toHaveLength(0);
    });

    it('org B cannot access org A detection by ID', async () => {
      const det = await createTestDetection(orgA.orgId, orgA.userId, { name: 'Private' });

      const res = await appRequest(app, 'GET', `/api/detections/${det.id}`, {
        cookie: orgB.cookie,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Alerts', () => {
    it('org B cannot see org A alerts', async () => {
      const sql = getTestSql();
      await sql`
        INSERT INTO alerts (org_id, severity, title, trigger_type, trigger_data)
        VALUES (${orgA.orgId}, 'critical', 'Org A Secret Alert', 'immediate', '{}'::jsonb)
      `;

      const res = await appRequest(app, 'GET', '/api/alerts', {
        cookie: orgB.cookie,
      });
      const body = await res.json() as any;
      expect(body.data).toHaveLength(0);
    });

    it('org B cannot access org A alert by ID', async () => {
      const sql = getTestSql();
      const [alert] = await sql`
        INSERT INTO alerts (org_id, severity, title, trigger_type, trigger_data)
        VALUES (${orgA.orgId}, 'high', 'Private Alert', 'immediate', '{}'::jsonb)
        RETURNING id
      `;

      const res = await appRequest(app, 'GET', `/api/alerts/${alert.id}`, {
        cookie: orgB.cookie,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Events', () => {
    it('org B cannot see org A events', async () => {
      await createTestEvent(orgA.orgId, {
        moduleId: 'github',
        eventType: 'github.push',
        payload: { secret: 'org-a-data' },
      });

      const res = await appRequest(app, 'GET', '/api/events', {
        cookie: orgB.cookie,
      });
      const body = await res.json() as any;
      expect(body.data).toHaveLength(0);
    });

    it('org B cannot access org A event by ID', async () => {
      const event = await createTestEvent(orgA.orgId, { moduleId: 'github' });

      const res = await appRequest(app, 'GET', `/api/events/${event.id}`, {
        cookie: orgB.cookie,
      });
      expect(res.status).toBe(404);
    });

    it('org B payload-search cannot find org A event payloads', async () => {
      await createTestEvent(orgA.orgId, {
        moduleId: 'github',
        eventType: 'github.push',
        payload: { secretField: 'leaked-value' },
      });

      const res = await appRequest(app, 'GET', '/api/events/payload-search', {
        cookie: orgB.cookie,
        query: { field: 'secretField', value: 'leaked-value' },
      });
      const body = await res.json() as any;
      expect(body.count).toBe(0);
    });
  });

  describe('Channels', () => {
    it('org B cannot see org A notification channels', async () => {
      await createTestNotificationChannel(orgA.orgId, {
        name: 'Org A Slack',
        type: 'slack',
        config: { channelId: 'C_SECRET' },
      });

      const res = await appRequest(app, 'GET', '/api/channels', {
        cookie: orgB.cookie,
      });
      const body = await res.json() as any;
      const orgAChannels = (body.data || body).filter((c: any) => c.name === 'Org A Slack');
      expect(orgAChannels).toHaveLength(0);
    });
  });

  describe('Notification deliveries', () => {
    it('org B cannot see org A notification deliveries', async () => {
      const sql = getTestSql();
      const [alert] = await sql`
        INSERT INTO alerts (org_id, severity, title, trigger_type, trigger_data)
        VALUES (${orgA.orgId}, 'high', 'Org A Alert', 'immediate', '{}'::jsonb)
        RETURNING id
      `;
      await sql`
        INSERT INTO notification_deliveries (alert_id, channel_id, channel_type, status)
        VALUES (${alert.id}, 'ch-secret', 'email', 'sent')
      `;

      const res = await appRequest(app, 'GET', '/api/notification-deliveries', {
        cookie: orgB.cookie,
      });
      const body = await res.json() as any;
      expect(body.data).toHaveLength(0);
    });
  });

  describe('GitHub installations', () => {
    it('org B cannot see org A GitHub installations', async () => {
      await createTestGithubInstallation(orgA.orgId, {
        installationId: 99999,
        targetLogin: 'secret-org',
      });

      const res = await appRequest(app, 'GET', '/modules/github/installations', {
        cookie: orgB.cookie,
      });
      const body = await res.json() as any;
      const list = body.data || body;
      expect(Array.isArray(list) ? list : []).toHaveLength(0);
    });
  });

  describe('Registry artifacts', () => {
    it('org B cannot see org A monitored artifacts', async () => {
      await createTestArtifact(orgA.orgId, { name: 'secret/image' });

      const res = await appRequest(app, 'GET', '/modules/registry/artifacts', {
        cookie: orgB.cookie,
      });
      const body = await res.json() as any;
      const list = body.data || body;
      expect(Array.isArray(list) ? list : []).toHaveLength(0);
    });
  });

  describe('API keys', () => {
    it('org B API key cannot access org A data', async () => {
      // Create detection in org A
      await createTestDetection(orgA.orgId, orgA.userId, { name: 'Org A Only' });

      // Create API key for org B
      const createKeyRes = await appRequest(app, 'POST', '/auth/api-keys', {
        cookie: orgB.cookie,
        body: { name: 'org-b-key', scopes: ['api:read'] },
      });
      const { key } = await createKeyRes.json() as any;

      // Use org B's API key to try to list detections
      const res = await appRequest(app, 'GET', '/api/detections', {
        headers: { Authorization: `Bearer ${key}` },
      });
      const body = await res.json() as any;
      expect(body.data).toHaveLength(0);
    });
  });

  describe('Alert stats', () => {
    it('org B alert stats do not include org A alerts', async () => {
      const sql = getTestSql();
      // Create 5 alerts in org A
      for (let i = 0; i < 5; i++) {
        await sql`
          INSERT INTO alerts (org_id, severity, title, trigger_type, trigger_data)
          VALUES (${orgA.orgId}, 'high', ${`Org A Alert ${i}`}, 'immediate', '{}'::jsonb)
        `;
      }

      const res = await appRequest(app, 'GET', '/api/alerts/stats', {
        cookie: orgB.cookie,
      });
      const body = await res.json() as any;
      expect(body.total ?? body.data?.total ?? 0).toBe(0);
    });
  });
});
