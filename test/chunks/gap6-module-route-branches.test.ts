/**
 * Audit Gap 6 — Module route branch coverage
 *
 * Tests that template resolution, dynamic imports, and module-specific
 * routes work for ALL 5 modules — not just the one used in happy path tests.
 * Catches missing module registrations and dead branches.
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
import { getApp, appRequest, setupAdmin } from '../../apps/api/src/__tests__/helpers.js';
import type { Hono } from 'hono';

let app: Hono<any>;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
});

describe('Gap 6 — Module route branch coverage', () => {
  describe('Template resolution for all modules', () => {
    const modules = ['github', 'registry', 'chain', 'infra', 'aws'];

    it.each(modules)('should resolve templates for %s module', async (moduleId) => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'GET', '/api/detections/resolve-template', {
        cookie: admin.cookie,
        query: { moduleId },
      });

      // Should either return templates or 200 with empty array — never 500
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('Detection creation for all modules', () => {
    const moduleConfigs = [
      {
        moduleId: 'github',
        rules: [{ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' }],
      },
      {
        moduleId: 'registry',
        rules: [{ ruleType: 'registry.digest_change', config: { changeTypes: ['digest_change'] }, action: 'alert' }],
      },
      {
        moduleId: 'chain',
        rules: [{ ruleType: 'chain.event_match', config: { eventSignature: '0xddf252ad' }, action: 'alert' }],
      },
      {
        moduleId: 'infra',
        rules: [{ ruleType: 'infra.cert_expiry', config: { daysThreshold: 30 }, action: 'alert' }],
      },
      {
        moduleId: 'aws',
        rules: [{ ruleType: 'aws.event_match', config: { eventNames: ['CreateUser'] }, action: 'alert' }],
      },
    ];

    it.each(moduleConfigs)('should create detection for $moduleId module', async ({ moduleId, rules }) => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'POST', '/api/detections', {
        cookie: admin.cookie,
        body: {
          moduleId,
          name: `${moduleId} Detection`,
          severity: 'high',
          rules,
        },
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.data.detection.moduleId).toBe(moduleId);
    });
  });

  describe('Module metadata endpoint', () => {
    it('should list all 5 registered modules', async () => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'GET', '/api/modules/metadata', {
        cookie: admin.cookie,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      const moduleIds = (body.data || body).map((m: any) => m.id);
      expect(moduleIds).toContain('github');
      expect(moduleIds).toContain('registry');
      expect(moduleIds).toContain('chain');
      expect(moduleIds).toContain('infra');
      expect(moduleIds).toContain('aws');
    });
  });

  describe('Module-specific route registration', () => {
    it('should mount GitHub module at /modules/github', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const res = await appRequest(app, 'GET', '/modules/github/installations', {
        cookie: session.cookie,
      });
      expect(res.status).toBe(200);
    });

    it('should mount Registry module at /modules/registry', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const res = await appRequest(app, 'GET', '/modules/registry/images', {
        cookie: session.cookie,
      });
      expect(res.status).toBe(200);
    });

    it('should mount Chain module at /modules/chain', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const res = await appRequest(app, 'GET', '/modules/chain/networks', {
        cookie: session.cookie,
      });
      expect(res.status).toBe(200);
    });

    it('should mount Infra module at /modules/infra', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const res = await appRequest(app, 'GET', '/modules/infra/hosts', {
        cookie: session.cookie,
      });
      expect(res.status).toBe(200);
    });

    it('should mount AWS module at /modules/aws', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const res = await appRequest(app, 'GET', '/modules/aws/integrations', {
        cookie: session.cookie,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('Rule schema endpoint — all module rule types', () => {
    const ruleTypes = [
      'github.repo_visibility',
      'github.branch_protection',
      'github.member_change',
      'github.deploy_key',
      'registry.digest_change',
      'registry.attribution',
      'chain.event_match',
      'chain.function_call_match',
      'infra.cert_expiry',
      'infra.score_degradation',
      'aws.event_match',
      'aws.root_activity',
    ];

    it.each(ruleTypes)('should return schema for rule type: %s', async (ruleType) => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'GET', '/api/detections/rule-schema', {
        cookie: admin.cookie,
        query: { ruleType },
      });

      // Should return schema or 404 — never 500
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('Analytics routes for all modules', () => {
    const analyticsRoutes = [
      '/api/github/analytics',
      '/api/registry/analytics',
      '/api/chain/analytics',
      '/api/infra/analytics',
      '/api/aws/analytics',
    ];

    it.each(analyticsRoutes)('should respond to %s', async (route) => {
      const admin = await setupAdmin(app);

      const res = await appRequest(app, 'GET', route, {
        cookie: admin.cookie,
      });

      // Should return data or 404 — never 500
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('Health check', () => {
    it('should verify both DB and Redis connections', async () => {
      const res = await appRequest(app, 'GET', '/health', {});

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.status).toBe('ok');
      expect(body.db).toBe('ok');
      expect(body.redis).toBe('ok');
    });
  });
});
