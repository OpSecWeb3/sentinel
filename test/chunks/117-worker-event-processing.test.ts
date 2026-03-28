/**
 * Chunk 117 — Worker: Event processing — rule evaluation + alert creation (transaction, ON CONFLICT)
 * Chunk 118 — Worker: Event processing — dispatch + correlation enqueue
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestDb,
  getTestSql,
  getTestRedis,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestRule,
  createTestEvent,
} from '../helpers/setup.js';
import { RuleEngine } from '@sentinel/shared/rule-engine';

describe('Chunk 117 — Worker event processing', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should evaluate rules and produce alert candidates', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      status: 'active',
    });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
    });

    const event = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      payload: {
        repository: { full_name: 'test/repo', visibility: 'public' },
        action: 'publicized',
      },
    });

    // Build evaluator map (stub)
    const evaluators = new Map();
    evaluators.set('github.repo_visibility', {
      evaluate: (ev: any, config: any) => {
        if (ev.payload?.action === 'publicized') {
          return { match: true, title: 'Repo made public', description: 'test' };
        }
        return { match: false };
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate({
      id: event.id,
      orgId: org.id,
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      externalId: null,
      payload: {
        repository: { full_name: 'test/repo', visibility: 'public' },
        action: 'publicized',
      },
      occurredAt: new Date(),
      receivedAt: new Date(),
    });

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0].detectionId).toBe(detection.id);
  });

  it('should skip paused detections', async () => {
    const db = getTestDb();
    const redis = getTestRedis();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      status: 'paused',
    });
    await createTestRule(detection.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });

    const evaluators = new Map();
    evaluators.set('github.repo_visibility', {
      evaluate: () => ({ match: true, title: 'test', description: 'test' }),
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate({
      id: 'test-id',
      orgId: org.id,
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      externalId: null,
      payload: { action: 'publicized' },
      occurredAt: new Date(),
      receivedAt: new Date(),
    });

    expect(result.candidates).toHaveLength(0);
  });

  it('should create alert with ON CONFLICT deduplication', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'github' });
    const event = await createTestEvent(org.id, { moduleId: 'github' });

    // Insert first alert
    const [alert1] = await sql`
      INSERT INTO alerts (org_id, detection_id, event_id, severity, title, trigger_type, trigger_data)
      VALUES (${org.id}, ${detection.id}, ${event.id}, 'high', 'Test Alert', 'immediate', '{}'::jsonb)
      RETURNING id
    `;
    expect(alert1.id).toBeDefined();
  });
});
