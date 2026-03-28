import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import type { Next } from 'hono';
import type { AuthContext } from '@sentinel/shared/hono-types';
import { getDb } from '@sentinel/db';
import { sessions } from '@sentinel/db/schema/core';
import { eq, and, ne, inArray } from '@sentinel/db';
import { encrypt, decrypt } from '@sentinel/shared/crypto';
import { logger as rootLogger } from '@sentinel/shared/logger';

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
    // This path should only be hit for sessions written before encryption was
    // introduced. All new sessions are stored encrypted (see encryptSession).
    // Log a warning so operators know legacy sessions are still in the store;
    // they can be invalidated by clearing the sessions table or waiting for
    // natural expiry. Once no warnings appear in production logs, this branch
    // can be removed.
    const legacy = sess as Record<string, unknown>;
    if (legacy && typeof legacy.userId === 'string') {
      rootLogger.warn({ userId: legacy.userId }, 'session: decrypted legacy plaintext session — encryption migration incomplete');
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

    if (row) {
      if (new Date(row.expire) > new Date()) {
        const sess = decryptSession(row.sess);
        if (sess) {
          c.set('userId', sess.userId);
          // Only populate orgId/role when the session actually carries them.
          // An empty string means "no org assigned yet" — leave the context
          // variables unset so truthy guards in requireOrg work correctly.
          if (sess.orgId) c.set('orgId', sess.orgId);
          if (sess.role) c.set('role', sess.role);
        }
      } else {
        // Session has expired — delete it from the DB asynchronously so it
        // does not accumulate indefinitely. Fire-and-forget; failure is not
        // fatal for this request.
        db.delete(sessions).where(eq(sessions.sid, sid)).catch((err) => {
          rootLogger.warn({ err, sid: sid.slice(0, 8) }, 'session: failed to delete expired session');
        });
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
    role: user.role ?? '',
  };

  await db.insert(sessions).values({
    sid,
    sess: encryptSession(sessionData),
    expire,
    userId: user.id,
    orgId: user.orgId ?? null,
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

/**
 * Delete all sessions belonging to the given userIds.
 * Uses the indexed `user_id` column for an efficient WHERE-based delete.
 */
export async function deleteSessionsByUserId(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const db = getDb();
  // Delete in chunks to avoid overly large IN clauses
  const CHUNK = 500;
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    await db.delete(sessions).where(inArray(sessions.userId, chunk));
  }
}

/**
 * Delete all sessions belonging to members of a given orgId.
 * Uses the indexed `org_id` column for an efficient WHERE-based delete.
 */
export async function deleteSessionsByOrgId(orgId: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.orgId, orgId));
}

/**
 * Delete all sessions for a userId EXCEPT the session identified by excludeSid.
 * Used by change-password to invalidate other active sessions while keeping the current one.
 */
export async function deleteSessionsByUserIdExcept(userId: string, excludeSid: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(
    and(eq(sessions.userId, userId), ne(sessions.sid, excludeSid)),
  );
}
