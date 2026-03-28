/**
 * Chunk 105 — Evaluator: ct_new_entry (ignorePatterns)
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

import type { NormalizedEvent } from '@sentinel/shared/rules';

function makeCTEvent(orgId: string, payload: Record<string, unknown>): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'infra',
    eventType: 'infra.ct_new_entry',
    externalId: null,
    payload,
    occurredAt: new Date(),
    receivedAt: new Date(),
  };
}

describe('Chunk 105 — Infra CT new entry evaluator', () => {
  let db: any;
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert on new CT log entry for watched domain', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'infra' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.ct_new_entry',
      config: { ignorePatterns: [] },
    });

    const evaluators = new Map();
    evaluators.set('infra:infra.ct_new_entry', {
      configSchema: { safeParse: () => ({ success: true, data: {} }) },
      evaluate: (ctx: any) => {
        const domain = ctx.event.payload?.domain as string;
        const ignorePatterns = ctx.rule.config.ignorePatterns ?? [];

        // Check if domain matches any ignore pattern
        for (const pattern of ignorePatterns) {
          if (domain.includes(pattern)) return null;
        }

        return {
          orgId: ctx.event.orgId,
          detectionId: ctx.rule.detectionId,
          ruleId: ctx.rule.id,
          eventId: ctx.event.id,
          severity: 'high',
          title: `New CT entry: ${domain}`,
          description: '',
          triggerType: 'immediate',
          triggerData: ctx.event.payload,
        };
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeCTEvent(org.id, {
      domain: 'new-service.example.com',
      logName: 'Google Argon',
      resourceId: 'example.com',
    }));

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('should ignore CT entries matching ignore patterns', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'infra' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.ct_new_entry',
      config: { ignorePatterns: ['staging', 'test'] },
    });

    const evaluators = new Map();
    evaluators.set('infra:infra.ct_new_entry', {
      configSchema: { safeParse: () => ({ success: true, data: {} }) },
      evaluate: (ctx: any) => {
        const domain = ctx.event.payload?.domain as string;
        const ignorePatterns = ctx.rule.config.ignorePatterns ?? [];

        for (const pattern of ignorePatterns) {
          if (domain.includes(pattern)) return null;
        }

        return {
          orgId: ctx.event.orgId,
          detectionId: ctx.rule.detectionId,
          ruleId: ctx.rule.id,
          eventId: ctx.event.id,
          severity: 'high',
          title: `New CT entry: ${domain}`,
          description: '',
          triggerType: 'immediate',
          triggerData: ctx.event.payload,
        };
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });

    const result = await engine.evaluate(makeCTEvent(org.id, {
      domain: 'staging-api.example.com',
      resourceId: 'example.com',
    }));

    expect(result.candidates).toHaveLength(0);
  });
});
