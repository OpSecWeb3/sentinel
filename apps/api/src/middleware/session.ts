import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import type { Next } from 'hono';
import type { AuthContext } from '@sentinel/shared/hono-types';
import { getDb } from '@sentinel/db';
import { sessions } from '@sentinel/db/schema/core';
import { eq } from '@sentinel/db';

const SESSION_COOKIE = 'sentinel.sid';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

export async function sessionMiddleware(c: AuthContext, next: Next) {
  const sid = getCookie(c, SESSION_COOKIE);

  if (sid) {
    const db = getDb();
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.sid, sid))
      .limit(1);

    if (row && new Date(row.expire) > new Date()) {
      const sess = row.sess as { userId: string; orgId: string; role: string };
      c.set('userId', sess.userId);
      c.set('orgId', sess.orgId);
      c.set('role', sess.role);
    }
  }

  await next();
}

export async function createSession(
  c: AuthContext,
  user: { id: string; orgId?: string; role?: string },
) {
  const db = getDb();
  const sid = crypto.randomBytes(32).toString('base64url');
  const expire = new Date(Date.now() + SESSION_MAX_AGE * 1000);

  await db.insert(sessions).values({
    sid,
    sess: { userId: user.id, orgId: user.orgId, role: user.role ?? 'viewer' },
    expire,
  });

  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

export async function destroySession(c: AuthContext) {
  const db = getDb();
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    await db.delete(sessions).where(eq(sessions.sid, sid));
    deleteCookie(c, SESSION_COOKIE);
  }
}
