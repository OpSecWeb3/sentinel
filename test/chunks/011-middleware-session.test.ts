/**
 * Chunk 011 — Middleware: Session encryption + decryption (legacy plaintext migration)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestSql,
  createTestUser,
  createTestOrg,
  addMembership,
} from '../helpers/setup.js';
import {
  getApp,
  appRequest,
  extractCookie,
  setupAdmin,
  login,
} from '../../apps/api/src/__tests__/helpers.js';
import type { Hono } from 'hono';

let app: Hono<any>;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
});

describe('Chunk 011 — Session encryption & decryption', () => {
  it('should store session data in encrypted format', async () => {
    const admin = await setupAdmin(app);
    const sql = getTestSql();

    // Look up the session that was just created
    const sid = admin.cookie.split('sentinel.sid=')[1]?.split(';')[0];
    const sessions = await sql`SELECT sess FROM sessions WHERE sid = ${sid}`;
    expect(sessions.length).toBe(1);

    const sess = sessions[0].sess;
    // Should be encrypted format: { _encrypted: "..." }
    expect(sess).toBeDefined();
    expect(sess._encrypted).toBeDefined();
    expect(typeof sess._encrypted).toBe('string');
    // Should NOT have plaintext userId
    expect(sess.userId).toBeUndefined();
  });

  it('should decrypt session and populate context on subsequent requests', async () => {
    const admin = await setupAdmin(app);

    const meRes = await appRequest(app, 'GET', '/auth/me', {
      cookie: admin.cookie,
    });

    expect(meRes.status).toBe(200);
    const me = await meRes.json() as any;
    expect(me.user.userId).toBe(admin.userId);
    expect(me.user.orgId).toBe(admin.orgId);
    expect(me.user.role).toBe('admin');
  });

  it('should handle legacy plaintext session format', async () => {
    const sql = getTestSql();
    const admin = await setupAdmin(app);

    // Manually insert a legacy plaintext session
    const legacySid = 'legacy-session-' + Date.now();
    const expire = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await sql`
      INSERT INTO sessions (sid, sess, expire, user_id, org_id)
      VALUES (${legacySid}, ${JSON.stringify({
        userId: admin.userId,
        orgId: admin.orgId,
        role: 'admin',
      })}::jsonb, ${expire.toISOString()}, ${admin.userId}, ${admin.orgId})
    `;

    // Use the legacy session
    const meRes = await appRequest(app, 'GET', '/auth/me', {
      cookie: `sentinel.sid=${legacySid}`,
    });

    expect(meRes.status).toBe(200);
    const me = await meRes.json() as any;
    expect(me.user.userId).toBe(admin.userId);
  });

  it('should reject expired sessions', async () => {
    const sql = getTestSql();
    const admin = await setupAdmin(app);

    // Insert an expired session
    const expiredSid = 'expired-session-' + Date.now();
    const expire = new Date(Date.now() - 1000); // already expired

    await sql`
      INSERT INTO sessions (sid, sess, expire, user_id, org_id)
      VALUES (${expiredSid}, ${JSON.stringify({
        userId: admin.userId,
        orgId: admin.orgId,
        role: 'admin',
      })}::jsonb, ${expire.toISOString()}, ${admin.userId}, ${admin.orgId})
    `;

    const meRes = await appRequest(app, 'GET', '/auth/me', {
      cookie: `sentinel.sid=${expiredSid}`,
    });

    expect(meRes.status).toBe(401);
  });

  it('should reject non-existent session ID', async () => {
    const meRes = await appRequest(app, 'GET', '/auth/me', {
      cookie: 'sentinel.sid=non-existent-sid-12345',
    });

    expect(meRes.status).toBe(401);
  });

  it('should destroy session on logout', async () => {
    const admin = await setupAdmin(app);

    await appRequest(app, 'POST', '/auth/logout', {
      cookie: admin.cookie,
    });

    // Session should be gone
    const meRes = await appRequest(app, 'GET', '/auth/me', {
      cookie: admin.cookie,
    });
    expect(meRes.status).toBe(401);
  });
});
