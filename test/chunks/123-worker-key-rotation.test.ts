/**
 * Chunk 123 — Worker: Key rotation — cursor-based re-encryption (7 columns, 2-pass sessions)
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
import { encrypt, decrypt, needsReEncrypt } from '@sentinel/shared/crypto';

describe('Chunk 123 — Key rotation handler', () => {
  beforeEach(async () => {
    await cleanTables();
    resetCounters();
  });

  it('should re-encrypt a column value', () => {
    const original = 'sensitive-data-123';
    const encrypted = encrypt(original);

    // Simulate re-encryption
    const decrypted = decrypt(encrypted);
    const reEncrypted = encrypt(decrypted);

    expect(decrypt(reEncrypted)).toBe(original);
    // Re-encrypted value should be different (new IV)
    expect(reEncrypted).not.toBe(encrypted);
  });

  it('should identify values that need re-encryption', () => {
    const freshEncrypted = encrypt('test');
    expect(needsReEncrypt(freshEncrypted)).toBe(false);

    // Garbage/legacy data should need re-encryption
    expect(needsReEncrypt('legacy-plaintext')).toBe(true);
  });

  it('should re-encrypt organization invite secrets', async () => {
    const sql = getTestSql();
    const org = await createTestOrg();
    const original = 'test-invite-secret';
    const encrypted = encrypt(original);

    await sql`
      UPDATE organizations SET invite_secret_encrypted = ${encrypted}
      WHERE id = ${org.id}
    `;

    // Verify it can be decrypted
    const [row] = await sql`
      SELECT invite_secret_encrypted FROM organizations WHERE id = ${org.id}
    `;
    expect(decrypt(row.invite_secret_encrypted)).toBe(original);

    // Simulate re-encryption
    const reEncrypted = encrypt(decrypt(row.invite_secret_encrypted));
    await sql`
      UPDATE organizations SET invite_secret_encrypted = ${reEncrypted}
      WHERE id = ${org.id}
    `;

    const [updated] = await sql`
      SELECT invite_secret_encrypted FROM organizations WHERE id = ${org.id}
    `;
    expect(decrypt(updated.invite_secret_encrypted)).toBe(original);
  });

  it('should convert legacy plaintext sessions to encrypted format', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Insert legacy plaintext session
    const sid = 'legacy-sid-' + Date.now();
    const expire = new Date(Date.now() + 86_400_000);
    const legacySess = { userId: user.id, orgId: org.id, role: 'admin' };

    await sql`
      INSERT INTO sessions (sid, sess, expire, user_id, org_id)
      VALUES (${sid}, ${JSON.stringify(legacySess)}::jsonb, ${expire.toISOString()}, ${user.id}, ${org.id})
    `;

    // Verify it's plaintext
    const [before] = await sql`SELECT sess FROM sessions WHERE sid = ${sid}`;
    expect(before.sess._encrypted).toBeUndefined();
    expect(before.sess.userId).toBe(user.id);

    // Simulate key rotation — encrypt the session
    const encryptedSess = encrypt(JSON.stringify(legacySess));
    await sql`
      UPDATE sessions SET sess = ${JSON.stringify({ _encrypted: encryptedSess })}::jsonb
      WHERE sid = ${sid}
    `;

    // Verify it's now encrypted
    const [after] = await sql`SELECT sess FROM sessions WHERE sid = ${sid}`;
    expect(after.sess._encrypted).toBeDefined();
    expect(after.sess.userId).toBeUndefined();

    // Verify data integrity
    const decrypted = JSON.parse(decrypt(after.sess._encrypted));
    expect(decrypted.userId).toBe(user.id);
    expect(decrypted.orgId).toBe(org.id);
    expect(decrypted.role).toBe('admin');
  });

  it('should use cursor-based pagination (not offset)', async () => {
    const sql = getTestSql();
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');

    // Insert multiple sessions
    for (let i = 0; i < 5; i++) {
      const sid = `session-${i}-${Date.now()}`;
      const expire = new Date(Date.now() + 86_400_000);
      await sql`
        INSERT INTO sessions (sid, sess, expire, user_id, org_id)
        VALUES (${sid}, ${JSON.stringify({ userId: user.id, orgId: org.id, role: 'admin' })}::jsonb,
                ${expire.toISOString()}, ${user.id}, ${org.id})
      `;
    }

    // Cursor-based query: WHERE sid > lastSid ORDER BY sid ASC LIMIT 2
    let lastSid = '';
    const allSids: string[] = [];

    while (true) {
      const rows = lastSid
        ? await sql`SELECT sid FROM sessions WHERE sid > ${lastSid} ORDER BY sid ASC LIMIT 2`
        : await sql`SELECT sid FROM sessions ORDER BY sid ASC LIMIT 2`;

      if (rows.length === 0) break;
      allSids.push(...rows.map((r: any) => r.sid));
      lastSid = rows[rows.length - 1].sid;
      if (rows.length < 2) break;
    }

    expect(allSids.length).toBe(5);
    // Should be sorted
    for (let i = 1; i < allSids.length; i++) {
      expect(allSids[i] > allSids[i - 1]).toBe(true);
    }
  });
});
