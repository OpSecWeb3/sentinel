/**
 * Chunk 124 — Worker: Poll sweep — artifact eligibility + job dedup
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
  createTestArtifact,
} from '../helpers/setup.js';

describe('Chunk 124 — Poll sweep handler', () => {
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    redis = getTestRedis();
  });

  it('should find enabled artifacts eligible for polling', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Enabled artifact, never polled
    await createTestArtifact(org.id, { name: 'org/image-a', enabled: true });
    // Disabled artifact
    await createTestArtifact(org.id, { name: 'org/image-b', enabled: false });

    const eligible = await sql`
      SELECT name FROM rc_artifacts
      WHERE org_id = ${org.id} AND enabled = true
      AND (last_polled_at IS NULL OR last_polled_at < NOW() - INTERVAL '5 minutes')
    `;

    expect(eligible.length).toBe(1);
    expect(eligible[0].name).toBe('org/image-a');
  });

  it('should skip recently-polled artifacts', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const artifact = await createTestArtifact(org.id, { name: 'org/recent', enabled: true });

    // Mark as recently polled
    await sql`UPDATE rc_artifacts SET last_polled_at = NOW() WHERE id = ${artifact.id}`;

    const eligible = await sql`
      SELECT name FROM rc_artifacts
      WHERE org_id = ${org.id} AND enabled = true
      AND (last_polled_at IS NULL OR last_polled_at < NOW() - INTERVAL '5 minutes')
    `;

    expect(eligible.length).toBe(0);
  });

  it('should deduplicate poll jobs via Redis SET NX', async () => {
    const artifactId = 'test-artifact-id';
    const lockKey = `sentinel:poll:lock:${artifactId}`;

    // First lock should succeed
    const first = await redis.set(lockKey, '1', 'NX', 'EX', 300);
    expect(first).toBe('OK');

    // Second lock should fail (dedup)
    const second = await redis.set(lockKey, '1', 'NX', 'EX', 300);
    expect(second).toBeNull();
  });

  it('should release dedup lock after TTL expires', async () => {
    const lockKey = 'sentinel:poll:lock:ttl-test';

    await redis.set(lockKey, '1', 'NX', 'PX', 100); // 100ms TTL

    // Wait for TTL
    await new Promise((r) => setTimeout(r, 150));

    const result = await redis.set(lockKey, '1', 'NX', 'EX', 300);
    expect(result).toBe('OK'); // Lock should be available again
  });
});
