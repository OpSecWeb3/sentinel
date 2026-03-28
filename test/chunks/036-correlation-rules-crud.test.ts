/**
 * Chunk 036 — Correlation rules: CRUD + config schema validation
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
  // Ensure the correlation_rules table exists. The shared test setup does not
  // create it, so we push it manually (idempotent).
  const sql = getTestSql();
  await sql`
    CREATE TABLE IF NOT EXISTS correlation_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL DEFAULT 'high',
      status TEXT NOT NULL DEFAULT 'active',
      config JSONB NOT NULL,
      channel_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
      slack_channel_id TEXT,
      slack_channel_name TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_correlation_rules_org ON correlation_rules(org_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_correlation_rules_status ON correlation_rules(status) WHERE status = 'active'`;

  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
  // Also truncate correlation_rules since cleanTables does not include it.
  const sql = getTestSql();
  await sql`TRUNCATE correlation_rules CASCADE`;
});

// ---------------------------------------------------------------------------
// Valid config fixtures
// ---------------------------------------------------------------------------

const VALID_SEQUENCE_CONFIG = {
  type: 'sequence' as const,
  correlationKey: [{ field: 'repository.full_name' }],
  windowMinutes: 60,
  steps: [
    {
      name: 'ProtectionDisabled',
      eventFilter: {
        moduleId: 'github',
        eventType: 'github.branch_protection_rule.deleted',
      },
    },
    {
      name: 'ForcePush',
      eventFilter: {
        moduleId: 'github',
        eventType: 'github.push',
        conditions: [{ field: 'forced', operator: '==' as const, value: true }],
      },
      matchConditions: [
        { field: 'sender.login', operator: '==' as const, ref: 'steps.ProtectionDisabled.sender.login' },
      ],
    },
  ],
};

const VALID_AGGREGATION_CONFIG = {
  type: 'aggregation' as const,
  correlationKey: [{ field: 'repository.full_name' }],
  windowMinutes: 30,
  aggregation: {
    eventFilter: { moduleId: 'github', eventType: 'github.push' },
    threshold: 10,
  },
};

const VALID_ABSENCE_CONFIG = {
  type: 'absence' as const,
  correlationKey: [{ field: 'repository.full_name' }],
  windowMinutes: 120,
  absence: {
    trigger: {
      eventFilter: { moduleId: 'github', eventType: 'github.push' },
    },
    expected: {
      eventFilter: { moduleId: 'github', eventType: 'github.deployment_status' },
      matchConditions: [],
    },
    graceMinutes: 60,
  },
};

describe('Chunk 036 — Correlation rules: CRUD + config schema validation', () => {
  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  it('should create a sequence correlation rule with valid config', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Disable-then-Force-Push',
        severity: 'critical',
        config: VALID_SEQUENCE_CONFIG,
        channelIds: [],
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.id).toBeDefined();
    expect(body.data.name).toBe('Disable-then-Force-Push');
    expect(body.data.severity).toBe('critical');
    expect(body.data.status).toBe('active');
    expect(body.data.config.type).toBe('sequence');
    expect(body.data.config.steps).toHaveLength(2);
  });

  it('should create an aggregation correlation rule', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Push Flood',
        severity: 'high',
        config: VALID_AGGREGATION_CONFIG,
        channelIds: [],
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.config.type).toBe('aggregation');
    expect(body.data.config.aggregation.threshold).toBe(10);
  });

  it('should create an absence correlation rule', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Missing Deploy',
        severity: 'medium',
        config: VALID_ABSENCE_CONFIG,
        channelIds: [],
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.config.type).toBe('absence');
    expect(body.data.config.absence.graceMinutes).toBe(60);
  });

  it('should default severity to high', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Default Severity',
        config: VALID_SEQUENCE_CONFIG,
        channelIds: [],
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.severity).toBe('high');
  });

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  it('should list correlation rules', async () => {
    const admin = await setupAdmin(app);

    // Create two rules
    await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Rule A', config: VALID_SEQUENCE_CONFIG, channelIds: [] },
    });
    await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Rule B', config: VALID_AGGREGATION_CONFIG, channelIds: [] },
    });

    const res = await appRequest(app, 'GET', '/api/correlation-rules', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(2);
  });

  it('should filter correlation rules by type', async () => {
    const admin = await setupAdmin(app);

    await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Seq Rule', config: VALID_SEQUENCE_CONFIG, channelIds: [] },
    });
    await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Agg Rule', config: VALID_AGGREGATION_CONFIG, channelIds: [] },
    });

    const res = await appRequest(app, 'GET', '/api/correlation-rules', {
      cookie: admin.cookie,
      query: { type: 'aggregation' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Agg Rule');
  });

  it('should return empty list when no rules exist', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'GET', '/api/correlation-rules', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  it('should update a correlation rule name', async () => {
    const admin = await setupAdmin(app);

    const createRes = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Old Name', config: VALID_SEQUENCE_CONFIG, channelIds: [] },
    });
    const ruleId = ((await createRes.json()) as any).data.id;

    const res = await appRequest(app, 'PATCH', `/api/correlation-rules/${ruleId}`, {
      cookie: admin.cookie,
      body: { name: 'New Name' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.name).toBe('New Name');
  });

  it('should update severity and status', async () => {
    const admin = await setupAdmin(app);

    const createRes = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Pausable', config: VALID_SEQUENCE_CONFIG, channelIds: [] },
    });
    const ruleId = ((await createRes.json()) as any).data.id;

    const res = await appRequest(app, 'PATCH', `/api/correlation-rules/${ruleId}`, {
      cookie: admin.cookie,
      body: { severity: 'low', status: 'paused' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.severity).toBe('low');
    expect(body.data.status).toBe('paused');
  });

  it('should update correlation rule config', async () => {
    const admin = await setupAdmin(app);

    const createRes = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Updatable', config: VALID_SEQUENCE_CONFIG, channelIds: [] },
    });
    const ruleId = ((await createRes.json()) as any).data.id;

    const updatedConfig = {
      ...VALID_SEQUENCE_CONFIG,
      windowMinutes: 120,
    };

    const res = await appRequest(app, 'PATCH', `/api/correlation-rules/${ruleId}`, {
      cookie: admin.cookie,
      body: { config: updatedConfig },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.config.windowMinutes).toBe(120);
  });

  it('should return 404 when updating non-existent rule', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'PATCH', '/api/correlation-rules/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
      body: { name: 'Ghost' },
    });

    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Delete (soft)
  // -----------------------------------------------------------------------

  it('should soft-delete a correlation rule', async () => {
    const admin = await setupAdmin(app);

    const createRes = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Doomed Rule', config: VALID_SEQUENCE_CONFIG, channelIds: [] },
    });
    const ruleId = ((await createRes.json()) as any).data.id;

    const delRes = await appRequest(app, 'DELETE', `/api/correlation-rules/${ruleId}`, {
      cookie: admin.cookie,
    });

    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as any;
    expect(delBody.data.status).toBe('deleted');
    expect(delBody.data.id).toBe(ruleId);
  });

  it('should exclude deleted rules from default list', async () => {
    const admin = await setupAdmin(app);

    const createRes = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Keep', config: VALID_SEQUENCE_CONFIG, channelIds: [] },
    });
    const keepId = ((await createRes.json()) as any).data.id;

    const create2Res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Remove', config: VALID_AGGREGATION_CONFIG, channelIds: [] },
    });
    const removeId = ((await create2Res.json()) as any).data.id;

    // Delete one rule
    await appRequest(app, 'DELETE', `/api/correlation-rules/${removeId}`, {
      cookie: admin.cookie,
    });

    // Default list excludes deleted
    const listRes = await appRequest(app, 'GET', '/api/correlation-rules', {
      cookie: admin.cookie,
    });

    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(keepId);
  });

  it('should return 404 when fetching a deleted rule by id', async () => {
    const admin = await setupAdmin(app);

    const createRes = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: { name: 'Gone', config: VALID_SEQUENCE_CONFIG, channelIds: [] },
    });
    const ruleId = ((await createRes.json()) as any).data.id;

    await appRequest(app, 'DELETE', `/api/correlation-rules/${ruleId}`, {
      cookie: admin.cookie,
    });

    const getRes = await appRequest(app, 'GET', `/api/correlation-rules/${ruleId}`, {
      cookie: admin.cookie,
    });

    expect(getRes.status).toBe(404);
  });

  it('should return 404 when deleting non-existent rule', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'DELETE', '/api/correlation-rules/00000000-0000-0000-0000-000000000000', {
      cookie: admin.cookie,
    });

    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Config schema validation
  // -----------------------------------------------------------------------

  it('should reject sequence config without steps', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Sequence',
        config: {
          type: 'sequence',
          correlationKey: [{ field: 'repo' }],
          windowMinutes: 60,
          // missing steps
        },
        channelIds: [],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject sequence config with only one step', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'One Step',
        config: {
          type: 'sequence',
          correlationKey: [{ field: 'repo' }],
          windowMinutes: 60,
          steps: [
            { name: 'OnlyStep', eventFilter: { eventType: 'test.event' } },
          ],
        },
        channelIds: [],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject aggregation config without aggregation field', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Aggregation',
        config: {
          type: 'aggregation',
          correlationKey: [{ field: 'repo' }],
          windowMinutes: 30,
          // missing aggregation
        },
        channelIds: [],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject absence config without absence field', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Absence',
        config: {
          type: 'absence',
          correlationKey: [{ field: 'repo' }],
          windowMinutes: 120,
          // missing absence
        },
        channelIds: [],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject config with missing correlationKey', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'No Key',
        config: {
          type: 'sequence',
          windowMinutes: 60,
          steps: [
            { name: 'A', eventFilter: { eventType: 'test.a' } },
            { name: 'B', eventFilter: { eventType: 'test.b' } },
          ],
        },
        channelIds: [],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject config with empty correlationKey array', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Empty Key',
        config: {
          type: 'sequence',
          correlationKey: [],
          windowMinutes: 60,
          steps: [
            { name: 'A', eventFilter: { eventType: 'test.a' } },
            { name: 'B', eventFilter: { eventType: 'test.b' } },
          ],
        },
        channelIds: [],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject config with invalid type', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        name: 'Bad Type',
        config: {
          type: 'invalid-type',
          correlationKey: [{ field: 'repo' }],
          windowMinutes: 60,
        },
        channelIds: [],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should reject missing name', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      cookie: admin.cookie,
      body: {
        config: VALID_SEQUENCE_CONFIG,
        channelIds: [],
      },
    });

    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  it('should reject unauthenticated request', async () => {
    const res = await appRequest(app, 'POST', '/api/correlation-rules', {
      body: {
        name: 'Unauthed',
        config: VALID_SEQUENCE_CONFIG,
        channelIds: [],
      },
    });

    expect(res.status).toBe(401);
  });
});
