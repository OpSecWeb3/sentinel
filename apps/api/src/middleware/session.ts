import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import type { Next } from 'hono';
import type { AuthContext } from '@sentinel/shared/hono-types';
import { getDb } from '@sentinel/db';
import { sessions } from '@sentinel/db/schema/core';
import { eq } from '@sentinel/db';
import { encrypt, decrypt } from '@sentinel/shared/crypto';

const SESSION_COOKIE = 'sentinel.sid';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

interface SessionData {
  userId: string;
  orgId: string;
  role: string;
}

/** Encrypt session data and wrap it for storage in the JSONB column. */
function encryptSession(data: SessionData): { _encrypted: string } {
  return { _encrypted: encrypt(JSON.stringify(data)) };
}

/**
 * Decrypt session data from the JSONB column.
 * Handles both encrypted (`{ _encrypted: "..." }`) and legacy plaintext formats
 * for backward compatibility during migration.
 */
function decryptSession(sess: unknown): SessionData | null {
  try {
    // New encrypted format: { _encrypted: "base64..." }
    if (
      typeof sess === 'object' &&
      sess !== null &&
      '_encrypted' in sess &&
      typeof (sess as Record<string, unknown>)._encrypted === 'string'
    ) {
      const plaintext = decrypt((sess as { _encrypted: string })._encrypted);
      return JSON.parse(plaintext) as SessionData;
    }

    // Legacy plaintext JSONB format: { userId, orgId, role }
    const legacy = sess as Record<string, unknown>;
    if (legacy && typeof legacy.userId === 'string') {
      return legacy as unknown as SessionData;
    }

    return null;
  } catch {
    return null;
  }
}

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
      const sess = decryptSession(row.sess);
      if (sess) {
        c.set('userId', sess.userId);
        c.set('orgId', sess.orgId);
        c.set('role', sess.role);
      }
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

  const sessionData: SessionData = {
    userId: user.id,
    orgId: user.orgId ?? '',
    role: user.role ?? 'viewer',
  };

  await db.insert(sessions).values({
    sid,
    sess: encryptSession(sessionData),
    expire,
  });

  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
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
