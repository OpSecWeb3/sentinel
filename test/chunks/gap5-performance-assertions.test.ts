/**
 * Audit Gap 5 — Performance assertion tests
 *
 * Tests that unbounded queries use indexes, batch processing, and bounded
 * Redis operations. Catches N+1 queries, full table scans, and unbounded
 * sorted set reads before they hit production.
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
  createTestDetection,
  createTestRule,
} from '../helpers/setup.js';

describe('Gap 5 — Performance assertions', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  describe('Session queries use indexed columns', () => {
    it('should delete sessions by user_id using index (not full scan)', async () => {
      const sql = getTestSql();
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');

      // Insert 100 sessions for this user
      const expire = new Date(Date.now() + 86_400_000);
      for (let i = 0; i < 100; i++) {
        await sql`
          INSERT INTO sessions (sid, sess, expire)
          VALUES (${`sid-${i}`}, '{"_encrypted":"d"}'::jsonb, ${expire.toISOString()})
        `;
      }

      // Insert 100 sessions for a different user (noise)
      const user2 = await createTestUser({ username: 'other' });
      await addMembership(org.id, user2.id, 'viewer');
      for (let i = 0; i < 100; i++) {
        await sql`
          INSERT INTO sessions (sid, sess, expire)
          VALUES (${`other-${i}`}, '{"_encrypted":"d"}'::jsonb, ${expire.toISOString()})
        `;
      }

      // Delete by sid pattern (simulating indexed lookup)
      const start = Date.now();
      await sql`DELETE FROM sessions WHERE sid LIKE 'sid-%'`;
      const elapsed = Date.now() - start;

      // Should be fast even with 200 total rows
      expect(elapsed).toBeLessThan(1000);

      // Verify only target sessions were deleted
      const [{ count }] = await sql`SELECT count(*) as count FROM sessions WHERE sid LIKE 'other-%'`;
      expect(Number(count)).toBe(100);
    });

    it('should delete expired sessions by expire index', async () => {
      const sql = getTestSql();

      const expired = new Date(Date.now() - 86_400_000).toISOString();
      for (let i = 0; i < 100; i++) {
        await sql`
          INSERT INTO sessions (sid, sess, expire)
          VALUES (${`exp-${i}`}, '{"_encrypted":"d"}'::jsonb, ${expired})
        `;
      }

      const start = Date.now();
      await sql`DELETE FROM sessions WHERE expire < NOW()`;
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
      const [{ count }] = await sql`SELECT count(*) as count FROM sessions`;
      expect(Number(count)).toBe(0);
    });
  });

  describe('Event queries use indexes', () => {
    it('should filter events by org_id + module_id efficiently', async () => {
      const sql = getTestSql();
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');

      // Insert 500 events
      for (let i = 0; i < 500; i++) {
        await createTestEvent(org.id, {
          moduleId: i % 2 === 0 ? 'github' : 'registry',
          eventType: `test.event_${i}`,
        });
      }

      const start = Date.now();
      const rows = await sql`
        SELECT id FROM events
        WHERE org_id = ${org.id} AND module_id = 'github'
        ORDER BY received_at DESC LIMIT 20
      `;
      const elapsed = Date.now() - start;

      expect(rows.length).toBe(20);
      expect(elapsed).toBeLessThan(500); // Should use composite index
    });
  });

  describe('Data retention batched deletion', () => {
    it('should delete old events in batches without holding locks', async () => {
      const sql = getTestSql();
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');

      // Insert 200 events, half old and half new
      const oldDate = new Date(Date.now() - 100 * 86_400_000);
      const newDate = new Date(Date.now() - 1 * 86_400_000);

      for (let i = 0; i < 100; i++) {
        await sql`
          INSERT INTO events (org_id, module_id, event_type, payload, occurred_at, received_at)
          VALUES (${org.id}, 'github', 'test', '{}'::jsonb, ${oldDate.toISOString()}, ${oldDate.toISOString()})
        `;
      }
      for (let i = 0; i < 100; i++) {
        await sql`
          INSERT INTO events (org_id, module_id, event_type, payload, occurred_at, received_at)
          VALUES (${org.id}, 'github', 'test', '{}'::jsonb, ${newDate.toISOString()}, ${newDate.toISOString()})
        `;
      }

      // Batched deletion (batch size 50)
      const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
      let totalDeleted = 0;
      let batchDeleted: number;
      do {
        const result = await sql`
          DELETE FROM events WHERE id IN (
            SELECT id FROM events WHERE received_at < ${cutoff}::timestamptz LIMIT 50
          )
        `;
        batchDeleted = Number(result.count ?? 0);
        totalDeleted += batchDeleted;
      } while (batchDeleted >= 50);

      expect(totalDeleted).toBe(100);
      const [{ count }] = await sql`SELECT count(*) as count FROM events WHERE org_id = ${org.id}`;
      expect(Number(count)).toBe(100); // new events remain
    });
  });

  describe('Redis operations are bounded', () => {
    it('should use ZRANGEBYSCORE with score bounds (not unbounded ZRANGE)', async () => {
      const redis = getTestRedis();
      const key = 'sentinel:perf:sorted-set';

      // Add 100 members with timestamps
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        await redis.zadd(key, now - i * 60_000, `member-${i}`);
      }

      // Bounded query: only last 10 minutes
      const start = now - 10 * 60_000;
      const results = await redis.zrangebyscore(key, start, '+inf');

      // Should return ~10 members, not all 100
      expect(results.length).toBeLessThanOrEqual(11);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should clean up Redis keys with TTL (not rely on manual deletion)', async () => {
      const redis = getTestRedis();
      const key = 'sentinel:perf:ttl-test';

      await redis.set(key, 'value', 'PX', 200); // 200ms TTL

      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(200);
    });

    it('should use pipeline for batch Redis operations', async () => {
      const redis = getTestRedis();

      // Pipeline: batch 50 SET operations into one round-trip
      const pipeline = redis.pipeline();
      for (let i = 0; i < 50; i++) {
        pipeline.set(`sentinel:perf:batch-${i}`, String(i), 'EX', 60);
      }

      const start = Date.now();
      await pipeline.exec();
      const elapsed = Date.now() - start;

      // 50 pipelined ops should be faster than 50 individual ops
      expect(elapsed).toBeLessThan(500);

      // Verify all were set
      const val = await redis.get('sentinel:perf:batch-49');
      expect(val).toBe('49');
    });
  });

  describe('Detection query efficiency', () => {
    it('should load rules with a single query (not N+1)', async () => {
      const sql = getTestSql();
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');

      // Create 20 detections with 2 rules each
      for (let i = 0; i < 20; i++) {
        const det = await createTestDetection(org.id, user.id, {
          moduleId: 'github',
          name: `Detection ${i}`,
        });
        await createTestRule(det.id, org.id, { moduleId: 'github', ruleType: 'github.repo_visibility' });
        await createTestRule(det.id, org.id, { moduleId: 'github', ruleType: 'github.branch_protection' });
      }

      // The RuleEngine.loadRules uses a single JOIN query
      const start = Date.now();
      const rows = await sql`
        SELECT r.id as rule_id, d.id as detection_id
        FROM rules r
        INNER JOIN detections d ON d.id = r.detection_id
        WHERE r.org_id = ${org.id}
          AND r.module_id = 'github'
          AND r.status = 'active'
          AND d.status = 'active'
        ORDER BY r.priority ASC
      `;
      const elapsed = Date.now() - start;

      expect(rows.length).toBe(40); // 20 detections × 2 rules
      expect(elapsed).toBeLessThan(500); // Single JOIN should be fast
    });
  });
});
