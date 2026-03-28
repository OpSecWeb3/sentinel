/**
 * Chunk 104 — Evaluator: header_missing (requiredHeaders, empty=defaults)
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
import { headerMissingEvaluator } from '../../modules/infra/src/evaluators/header-missing.js';

function makeHeaderEvent(
  orgId: string,
  hostname: string,
  missingHeaders: string[],
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    orgId,
    moduleId: 'infra',
    eventType: 'infra.header.missing',
    externalId: null,
    payload: { hostname, missingHeaders },
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('Chunk 104 — header_missing evaluator', () => {
  let db: any;
  let redis: any;
  const evaluators = new Map([['infra:infra.header_missing', headerMissingEvaluator]]);

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should alert when a required security header is missing', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'infra' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.header_missing',
      config: {
        requiredHeaders: ['HSTS', 'CSP', 'X-Frame-Options'],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeHeaderEvent(org.id, 'api.example.com', ['HSTS', 'X-Frame-Options']),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toContain('Missing security headers');
    expect(result.candidates[0]!.description).toContain('HSTS');
    expect(result.candidates[0]!.description).toContain('X-Frame-Options');
  });

  it('should not alert when all required headers are present', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'infra' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.header_missing',
      config: {
        requiredHeaders: ['HSTS', 'CSP'],
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    // Report missing Referrer-Policy, but we only require HSTS and CSP
    const result = await engine.evaluate(
      makeHeaderEvent(org.id, 'api.example.com', ['Referrer-Policy']),
    );

    expect(result.candidates).toHaveLength(0);
  });

  it('should use all default headers when requiredHeaders is empty', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'infra' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.header_missing',
      config: {
        requiredHeaders: [], // empty = check all known security headers
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    // Missing one of the default headers
    const result = await engine.evaluate(
      makeHeaderEvent(org.id, 'shop.example.com', ['Permissions-Policy']),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.description).toContain('Permissions-Policy');
  });

  it('should not alert when missing headers do not intersect with required', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'infra' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.header_missing',
      config: {
        requiredHeaders: ['X-Custom-Header'], // non-standard header
      },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    // Missing HSTS but we only require X-Custom-Header
    const result = await engine.evaluate(
      makeHeaderEvent(org.id, 'api.example.com', ['HSTS']),
    );

    expect(result.candidates).toHaveLength(0);
  });

  it('should not alert for wrong event type', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const detection = await createTestDetection(org.id, user.id, { moduleId: 'infra' });
    await createTestRule(detection.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.header_missing',
      config: { requiredHeaders: [] },
    });

    const engine = new RuleEngine({ evaluators, redis, db, logger: console as any });
    const result = await engine.evaluate(
      makeHeaderEvent(org.id, 'api.example.com', ['HSTS'], {
        eventType: 'infra.cert_expiry', // wrong event type
      }),
    );

    expect(result.candidates).toHaveLength(0);
  });
});
