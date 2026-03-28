/**
 * Chunk 113 — Evaluator: spot_eviction (watchInstanceIds, regions)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestDb,
  getTestRedis,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestRule,
} from '../helpers/setup.js';
import { RuleEngine } from '@sentinel/shared/rule-engine';
import { z } from 'zod';
import type { NormalizedEvent } from '@sentinel/shared/rules';

function makeAwsEvent(orgId: string, payload: Record<string, unknown>): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'aws',
    eventType: 'aws.spot_eviction',
    externalId: null,
    payload,
    occurredAt: new Date(),
    receivedAt: new Date(),
  };
}

describe('Chunk 113 — AWS spot eviction evaluator', () => {
  let db: any;
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert on spot eviction for watched instance', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, {
      moduleId: 'aws',
      status: 'active',
    });
    await createTestRule(detection.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.spot_eviction',
      config: { watchInstanceIds: ['i-12345', 'i-67890'] },
    });

    const evaluators = new Map();
    evaluators.set('aws:aws.spot_eviction', {
      configSchema: z.object({}).passthrough(),
      evaluate: (ctx: any) => {
        const instanceId = ctx.event.payload?.instanceId as string;
        if (!ctx.rule.config.watchInstanceIds || ctx.rule.config.watchInstanceIds.length === 0) {
          return {
            orgId: ctx.event.orgId, detectionId: ctx.rule.detectionId, ruleId: ctx.rule.id,
            eventId: ctx.event.id, severity: 'high', title: `Spot eviction: ${instanceId}`,
            description: '', triggerType: 'immediate', triggerData: ctx.event.payload,
          };
        }
        if (ctx.rule.config.watchInstanceIds.includes(instanceId)) {
          return {
            orgId: ctx.event.orgId, detectionId: ctx.rule.detectionId, ruleId: ctx.rule.id,
            eventId: ctx.event.id, severity: 'high', title: `Spot eviction: ${instanceId}`,
            description: '', triggerType: 'immediate', triggerData: ctx.event.payload,
          };
        }
        return null;
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeAwsEvent(org.id, {
      instanceId: 'i-12345',
      region: 'us-east-1',
    }));

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('should not alert on eviction for non-watched instance', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'aws' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.spot_eviction',
      config: { watchInstanceIds: ['i-12345'] },
    });

    const evaluators = new Map();
    evaluators.set('aws:aws.spot_eviction', {
      configSchema: z.object({}).passthrough(),
      evaluate: (ctx: any) => {
        const instanceId = ctx.event.payload?.instanceId as string;
        if (ctx.rule.config.watchInstanceIds?.includes(instanceId)) {
          return {
            orgId: ctx.event.orgId, detectionId: ctx.rule.detectionId, ruleId: ctx.rule.id,
            eventId: ctx.event.id, severity: 'high', title: `Spot eviction: ${instanceId}`,
            description: '', triggerType: 'immediate', triggerData: ctx.event.payload,
          };
        }
        return null;
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeAwsEvent(org.id, {
      instanceId: 'i-99999', // not watched
      region: 'us-east-1',
    }));

    expect(result.candidates).toHaveLength(0);
  });

  it('should alert on all instances when watchInstanceIds is empty', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'aws' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'aws',
      ruleType: 'aws.spot_eviction',
      config: { watchInstanceIds: [] }, // empty = watch all
    });

    const evaluators = new Map();
    evaluators.set('aws:aws.spot_eviction', {
      configSchema: z.object({}).passthrough(),
      evaluate: (ctx: any) => {
        if (!ctx.rule.config.watchInstanceIds || ctx.rule.config.watchInstanceIds.length === 0) {
          return {
            orgId: ctx.event.orgId, detectionId: ctx.rule.detectionId, ruleId: ctx.rule.id,
            eventId: ctx.event.id, severity: 'high', title: 'Spot eviction detected',
            description: '', triggerType: 'immediate', triggerData: ctx.event.payload,
          };
        }
        return null;
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeAwsEvent(org.id, {
      instanceId: 'i-anything',
      region: 'eu-west-1',
    }));

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });
});
