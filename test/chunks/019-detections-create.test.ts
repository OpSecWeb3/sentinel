/**
 * Chunk 019 — Detections: Create with rules (validation, atomicity, required fields)
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

describe('Chunk 019 — Create detection with rules', () => {
  it('should create a detection with one rule', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        name: 'Repo Visibility Alert',
        severity: 'high',
        rules: [
          { ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' },
        ],
      },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.detection.id).toBeDefined();
    expect(body.data.detection.moduleId).toBe('github');
    expect(body.data.detection.name).toBe('Repo Visibility Alert');
    expect(body.data.rules).toHaveLength(1);
    expect(body.data.rules[0].ruleType).toBe('github.repo_visibility');
  });

  it('should create a detection with multiple rules atomically', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        name: 'Multi-Rule Detection',
        severity: 'critical',
        rules: [
          { ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' }, action: 'alert' },
          { ruleType: 'github.branch_protection', config: { watchBranches: ['main'] }, action: 'alert' },
        ],
      },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.rules).toHaveLength(2);
  });

  it('should require at least one rule', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        name: 'No Rules',
        severity: 'high',
        rules: [],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should require moduleId', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        name: 'Missing Module',
        severity: 'high',
        rules: [{ ruleType: 'github.repo_visibility', config: {}, action: 'alert' }],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should require name', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        severity: 'high',
        rules: [{ ruleType: 'github.repo_visibility', config: {}, action: 'alert' }],
      },
    });

    expect(res.status).toBe(400);
  });

  it('should default severity to high', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        name: 'Default Severity',
        rules: [{ ruleType: 'github.repo_visibility', config: {}, action: 'alert' }],
      },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.detection.severity).toBe('high');
  });

  it('should set channelIds and cooldownMinutes', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        name: 'With Options',
        severity: 'medium',
        cooldownMinutes: 30,
        channelIds: [],
        rules: [{ ruleType: 'github.repo_visibility', config: {}, action: 'alert' }],
      },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.detection.cooldownMinutes).toBe(30);
  });

  it('should set rule priority and action', async () => {
    const admin = await setupAdmin(app);

    const res = await appRequest(app, 'POST', '/api/detections', {
      cookie: admin.cookie,
      body: {
        moduleId: 'github',
        name: 'Priority Test',
        severity: 'low',
        rules: [
          { ruleType: 'github.repo_visibility', config: {}, action: 'suppress', priority: 10 },
        ],
      },
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.rules[0].action).toBe('suppress');
    expect(body.data.rules[0].priority).toBe(10);
  });
});
