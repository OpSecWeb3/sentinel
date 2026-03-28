/**
 * Chunk 119 — Worker: Correlation evaluation — CorrelationEngine → alert creation
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestDb,
  getTestSql,
  getTestRedis,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestEvent,
} from '../helpers/setup.js';
import { CorrelationEngine } from '@sentinel/shared/correlation-engine';

describe('Chunk 119 — Worker correlation evaluation', () => {
  let db: any;
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    db = getTestDb();
    redis = getTestRedis();
  });

  it('should produce alert when sequence completes', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Insert correlation rule
    await sql`
      INSERT INTO correlation_rules (id, org_id, name, severity, config, status)
      VALUES (gen_random_uuid(), ${org.id}, 'Test Sequence', 'high',
        ${JSON.stringify({
          type: 'sequence',
          moduleId: 'github',
          steps: [
            { eventType: 'github.repo_visibility', conditions: [] },
            { eventType: 'github.push', conditions: [] },
          ],
          windowMinutes: 10,
          groupBy: 'payload.repository.full_name',
        })}::jsonb, 'active')
    `;

    const engine = new CorrelationEngine({ db, redis, logger: console as any });

    // First step event
    const event1 = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      payload: { repository: { full_name: 'org/repo' } },
    });

    const result1 = await engine.evaluate({
      id: event1.id,
      orgId: org.id,
      moduleId: 'github',
      eventType: 'github.repo_visibility',
      externalId: null,
      payload: { repository: { full_name: 'org/repo' } },
      occurredAt: new Date(),
      receivedAt: new Date(),
    });

    // First step should not produce alert yet
    expect(result1.alerts).toHaveLength(0);

    // Second step event
    const event2 = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.push',
      payload: { repository: { full_name: 'org/repo' } },
    });

    const result2 = await engine.evaluate({
      id: event2.id,
      orgId: org.id,
      moduleId: 'github',
      eventType: 'github.push',
      externalId: null,
      payload: { repository: { full_name: 'org/repo' } },
      occurredAt: new Date(),
      receivedAt: new Date(),
    });

    // Second step should complete the sequence and produce alert
    expect(result2.alerts.length).toBeGreaterThanOrEqual(1);
  });
});
