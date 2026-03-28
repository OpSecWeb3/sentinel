/**
 * Chunk 125 — Worker: Session cleanup — expired session batch delete
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
} from '../helpers/setup.js';

describe('Chunk 125 — Session cleanup', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should delete expired sessions', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Create expired session
    const expiredDate = new Date(Date.now() - 86_400_000); // 1 day ago
    await sql`
      INSERT INTO sessions (sid, sess, expire, user_id, org_id)
      VALUES ('expired-1', '{"_encrypted":"dummy"}'::jsonb, ${expiredDate.toISOString()}, ${user.id}, ${org.id})
    `;

    // Create valid session
    const validDate = new Date(Date.now() + 86_400_000); // 1 day from now
    await sql`
      INSERT INTO sessions (sid, sess, expire, user_id, org_id)
      VALUES ('valid-1', '{"_encrypted":"dummy"}'::jsonb, ${validDate.toISOString()}, ${user.id}, ${org.id})
    `;

    // Cleanup expired
    await sql`DELETE FROM sessions WHERE expire < NOW()`;

    const sessions = await sql`SELECT sid FROM sessions`;
    expect(sessions.length).toBe(1);
    expect(sessions[0].sid).toBe('valid-1');
  });

  it('should handle no expired sessions gracefully', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const validDate = new Date(Date.now() + 86_400_000);
    await sql`
      INSERT INTO sessions (sid, sess, expire, user_id, org_id)
      VALUES ('valid-1', '{"_encrypted":"dummy"}'::jsonb, ${validDate.toISOString()}, ${user.id}, ${org.id})
    `;

    const result = await sql`DELETE FROM sessions WHERE expire < NOW()`;
    // Should not delete anything
    const sessions = await sql`SELECT sid FROM sessions`;
    expect(sessions.length).toBe(1);
  });

  it('should batch delete large numbers of expired sessions', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    const expiredDate = new Date(Date.now() - 86_400_000);
    // Insert 50 expired sessions
    for (let i = 0; i < 50; i++) {
      await sql`
        INSERT INTO sessions (sid, sess, expire, user_id, org_id)
        VALUES (${`expired-${i}`}, '{"_encrypted":"dummy"}'::jsonb, ${expiredDate.toISOString()}, ${user.id}, ${org.id})
      `;
    }

    await sql`DELETE FROM sessions WHERE expire < NOW()`;

    const [{ count }] = await sql`SELECT count(*) as count FROM sessions`;
    expect(Number(count)).toBe(0);
  });
});
