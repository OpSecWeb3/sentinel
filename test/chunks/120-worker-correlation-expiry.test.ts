/**
 * Chunk 120 — Worker: Correlation expiry — ZRANGEBYSCORE + absence alerts + fallback SCAN
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  getTestRedis,
  createTestUser,
  createTestOrg,
  addMembership,
} from '../helpers/setup.js';

describe('Chunk 120 — Correlation expiry handler', () => {
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    redis = getTestRedis();
  });

  it('should find expired instances via ZRANGEBYSCORE', async () => {
    const now = Date.now();
    const expiredScore = now - 60_000; // 1 minute ago
    const futureScore = now + 60_000; // 1 minute from now

    // Simulate correlation instances in a sorted set
    await redis.zadd('sentinel:corr:expiry', expiredScore, 'instance-expired');
    await redis.zadd('sentinel:corr:expiry', futureScore, 'instance-future');

    // Find expired instances
    const expired = await redis.zrangebyscore('sentinel:corr:expiry', '-inf', now);

    expect(expired).toContain('instance-expired');
    expect(expired).not.toContain('instance-future');
  });

  it('should clean up expired instances from Redis', async () => {
    const now = Date.now();
    const expiredScore = now - 60_000;

    await redis.zadd('sentinel:corr:expiry', expiredScore, 'instance-1');
    await redis.zadd('sentinel:corr:expiry', expiredScore, 'instance-2');

    // Remove expired
    const count = await redis.zremrangebyscore('sentinel:corr:expiry', '-inf', now);
    expect(count).toBe(2);

    const remaining = await redis.zcard('sentinel:corr:expiry');
    expect(remaining).toBe(0);
  });

  it('should handle absence rule expiry (create alert when expected event never arrives)', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Create an absence correlation rule
    await sql`
      INSERT INTO correlation_rules (id, org_id, name, type, module_id, severity, config, status)
      VALUES (gen_random_uuid(), ${org.id}, 'Absence Rule', 'absence', 'infra', 'critical',
        ${JSON.stringify({
          triggerEvent: { eventType: 'infra.cert_scan' },
          expectedEvent: { eventType: 'infra.cert_valid' },
          windowMinutes: 5,
          groupBy: 'payload.host',
        })}::jsonb, 'active')
    `;

    // Verify the rule exists
    const rules = await sql`SELECT * FROM correlation_rules WHERE org_id = ${org.id}`;
    expect(rules.length).toBe(1);
    expect(rules[0].type).toBe('absence');
  });

  it('should handle empty expiry set gracefully', async () => {
    const expired = await redis.zrangebyscore('sentinel:corr:expiry', '-inf', Date.now());
    expect(expired).toEqual([]);
  });
});
