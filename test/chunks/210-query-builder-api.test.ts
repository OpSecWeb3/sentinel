/**
 * Integration tests for POST /api/query and GET /api/field-catalog.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { getApp, appRequest, setupAdmin } from '../../apps/api/src/__tests__/helpers.js';
import { cleanTables, resetCounters, getTestSql } from '../helpers/setup.js';

let app: Hono<AppEnv>;
let cookie: string;
let orgId: string;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
  const admin = await setupAdmin(app);
  cookie = admin.cookie;
  orgId = admin.orgId;
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedEvents() {
  const sql = getTestSql();
  await sql`
    INSERT INTO events (org_id, module_id, event_type, external_id, payload, occurred_at, received_at)
    VALUES
      (${orgId}, 'github', 'github.push', 'gh-1',
       ${'{"resourceId":"acme/api","ref":"refs/heads/main","forced":true,"sender":{"login":"dev"},"commits_count":3}'}::jsonb,
       NOW() - interval '1 hour', NOW() - interval '1 hour'),
      (${orgId}, 'github', 'github.member.added', 'gh-2',
       ${'{"resourceId":"acme/api","action":"added","member":{"login":"octocat"},"sender":{"login":"admin"}}'}::jsonb,
       NOW() - interval '2 hours', NOW() - interval '2 hours'),
      (${orgId}, 'aws', 'aws.iam.CreateAccessKey', 'aws-1',
       ${'{"eventName":"CreateAccessKey","sourceIPAddress":"203.0.113.42","awsRegion":"us-east-1","errorCode":"AccessDenied"}'}::jsonb,
       NOW() - interval '3 hours', NOW() - interval '3 hours'),
      (${orgId}, 'aws', 'aws.cloudtrail.StopLogging', 'aws-2',
       ${'{"eventName":"StopLogging","sourceIPAddress":"198.51.100.7","awsRegion":"eu-west-1"}'}::jsonb,
       NOW() - interval '5 hours', NOW() - interval '5 hours'),
      (${orgId}, 'chain', 'chain.event.matched', 'chain-1',
       ${'{"resourceId":"0xdAC17F","matchType":"chain.event_match","networkSlug":"ethereum","chainId":1,"eventName":"Transfer"}'}::jsonb,
       NOW() - interval '1 day', NOW() - interval '1 day')
  `;
}

async function seedAlerts() {
  const sql = getTestSql();
  await sql`
    INSERT INTO alerts (org_id, severity, title, trigger_type, trigger_data, notification_status)
    VALUES
      (${orgId}, 'critical', 'Repo made public', 'immediate',
       ${'{"resourceId":"acme/secrets","action":"publicized","sender":{"login":"dev"}}'}::jsonb,
       'sent'),
      (${orgId}, 'high', 'Force push to main', 'immediate',
       ${'{"ref":"refs/heads/main","forced":true,"sender":{"login":"dev"}}'}::jsonb,
       'pending'),
      (${orgId}, 'critical', 'Fund drainage', 'windowed',
       ${'{"type":"balance-track","address":"0x1111","percentChange":-99.99,"direction":"drop"}'}::jsonb,
       'failed')
  `;
}

async function seedCatalog() {
  const sql = getTestSql();
  await sql`TRUNCATE payload_field_catalog`;
  await sql`
    INSERT INTO payload_field_catalog (source, source_type, field_path, field_type)
    VALUES
      ('events', 'github', 'resourceId', 'string'),
      ('events', 'github', 'sender', 'object'),
      ('events', 'github', 'sender.login', 'string'),
      ('events', 'github', 'forced', 'boolean'),
      ('events', 'aws', 'eventName', 'string'),
      ('events', 'aws', 'sourceIPAddress', 'string'),
      ('events', 'aws', 'errorCode', 'string'),
      ('alerts', 'immediate', 'resourceId', 'string'),
      ('alerts', 'immediate', 'sender.login', 'string'),
      ('alerts', 'windowed', 'type', 'string'),
      ('alerts', 'windowed', 'percentChange', 'number')
  `;
}

// ===========================================================================
// POST /api/query — events
// ===========================================================================

describe('POST /api/query — events', () => {
  beforeEach(seedEvents);

  it('returns all events with a simple query', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'moduleId', operator: 'eq', value: 'github' }] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(2);
  });

  it('filters by payload field path using eq', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'payload.member.login', operator: 'eq', value: 'octocat' }] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(1);
  });

  it('filters using IN operator', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'moduleId', operator: 'in', value: ['github', 'chain'] }] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(3); // 2 github + 1 chain
  });

  it('filters using EXISTS on payload field', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [
          { id: 'c1', field: 'moduleId', operator: 'eq', value: 'aws' },
          { id: 'c2', field: 'payload.errorCode', operator: 'exists', value: '' },
        ] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(1); // only the CreateAccessKey with errorCode
  });

  it('applies time range filter', async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 3600_000).toISOString();
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'moduleId', operator: 'eq', value: 'aws' }] }],
        timeRange: { from: fourHoursAgo, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(1); // only the 3-hour-old event, not the 5-hour one
  });

  it('returns pagination metadata', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'moduleId', operator: 'eq', value: 'github' }] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 1,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { meta: { page: number; limit: number; total: number; totalPages: number } };
    expect(body.meta.page).toBe(1);
    expect(body.meta.limit).toBe(1);
    expect(body.meta.total).toBe(2);
    expect(body.meta.totalPages).toBe(2);
  });

  it('rejects invalid field path (SQL injection attempt)', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'moduleId; DROP TABLE events', operator: 'eq', value: 'x' }] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty groups array', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'moduleId', operator: 'eq', value: 'github' }] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// POST /api/query — alerts
// ===========================================================================

describe('POST /api/query — alerts', () => {
  beforeEach(seedAlerts);

  it('queries alerts by severity', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'alerts',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'severity', operator: 'eq', value: 'critical' }] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(2); // repo public + fund drainage
  });

  it('queries alerts with OR logic', async () => {
    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'alerts',
        groups: [{ id: 'g1', logic: 'OR', clauses: [
          { id: 'c1', field: 'notificationStatus', operator: 'eq', value: 'pending' },
          { id: 'c2', field: 'notificationStatus', operator: 'eq', value: 'failed' },
        ] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 25,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(2); // pending + failed
  });
});

// ===========================================================================
// POST /api/query — org isolation
// ===========================================================================

describe('POST /api/query — org isolation', () => {
  it('does not return events from other orgs', async () => {
    // Seed an event for the test org
    await seedEvents();

    // Seed an event for a different org
    const sql = getTestSql();
    const [otherOrg] = await sql`INSERT INTO organizations (name, slug) VALUES ('Other Org', 'other-org') RETURNING id`;
    await sql`
      INSERT INTO events (org_id, module_id, event_type, external_id, payload, occurred_at)
      VALUES (${otherOrg.id}, 'github', 'github.push', 'other-1',
        '{"resourceId":"other/repo"}'::jsonb, NOW())
    `;

    const res = await appRequest(app, 'POST', '/api/query', {
      cookie,
      body: {
        collection: 'events',
        groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: 'moduleId', operator: 'eq', value: 'github' }] }],
        timeRange: { from: null, to: null },
        aggregation: null,
        orderBy: null,
        limit: 100,
        page: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ orgId: string }>; meta: { total: number } };

    // Should only see our org's events
    for (const row of body.data) {
      expect(row.orgId).toBe(orgId);
    }
    expect(body.meta.total).toBe(2); // only our 2 github events
  });
});

// ===========================================================================
// GET /api/field-catalog
// ===========================================================================

describe('GET /api/field-catalog', () => {
  beforeEach(seedCatalog);

  it('returns all catalog entries', async () => {
    const res = await appRequest(app, 'GET', '/api/field-catalog', { cookie });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(body.data.length).toBeGreaterThanOrEqual(11);
  });

  it('filters by source', async () => {
    const res = await appRequest(app, 'GET', '/api/field-catalog', {
      cookie,
      query: { source: 'events' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ source: string }> };
    for (const row of body.data) {
      expect(row.source).toBe('events');
    }
  });

  it('filters by source and sourceType', async () => {
    const res = await appRequest(app, 'GET', '/api/field-catalog', {
      cookie,
      query: { source: 'events', sourceType: 'github' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ sourceType: string; fieldPath: string }> };
    expect(body.data.length).toBe(4); // resourceId, sender, sender.login, forced
    for (const row of body.data) {
      expect(row.sourceType).toBe('github');
    }
  });

  it('filters alert catalog fields', async () => {
    const res = await appRequest(app, 'GET', '/api/field-catalog', {
      cookie,
      query: { source: 'alerts', sourceType: 'windowed' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ fieldPath: string; fieldType: string }> };
    expect(body.data).toHaveLength(2);
    expect(body.data.map((r) => r.fieldPath).sort()).toEqual(['percentChange', 'type']);
  });

  it('requires authentication', async () => {
    const res = await appRequest(app, 'GET', '/api/field-catalog', {});
    expect(res.status).toBe(401);
  });
});
