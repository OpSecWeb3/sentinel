/**
 * Org-wide notify key auth — for CI pipelines and external integrations.
 * Ported from Verity's notifyKeyAuth.
 *
 * Keys use 'snk_' prefix (sentinel notify key), stored as SHA-256 hash on the org.
 */
import crypto from 'node:crypto';
import type { Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthContext } from '@sentinel/shared/hono-types';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { getDb } from '@sentinel/db';
import { organizations } from '@sentinel/db/schema/core';
import { eq } from '@sentinel/db';

const NOTIFY_KEY_PREFIX = 'snk_';

export async function notifyKeyMiddleware(c: AuthContext, next: Next) {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith(`Bearer ${NOTIFY_KEY_PREFIX}`)) return next();

  const rawKey = auth.slice(7); // Remove "Bearer "
  const prefix = rawKey.slice(0, NOTIFY_KEY_PREFIX.length + 8);

  try {
    const db = getDb();

    // Prefix lookup for fast filtering
    const [org] = await db.select({ id: organizations.id, notifyKeyHash: organizations.notifyKeyHash })
      .from(organizations)
      .where(eq(organizations.notifyKeyPrefix, prefix))
      .limit(1);

    if (!org?.notifyKeyHash) return next();

    // Full hash verify (timing-safe comparison)
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const hashBuffer = Buffer.from(keyHash, 'hex');
    const storedBuffer = Buffer.from(org.notifyKeyHash, 'hex');
    if (hashBuffer.length !== storedBuffer.length || !crypto.timingSafeEqual(hashBuffer, storedBuffer)) {
      return next();
    }

    c.set('notifyKeyOrgId', org.id);

    // Fire-and-forget last_used_at
    db.update(organizations)
      .set({ notifyKeyLastUsedAt: new Date() })
      .where(eq(organizations.id, org.id))
      .catch((err) => { rootLogger.debug({ err, orgId: org.id }, 'Failed to update notifyKey lastUsedAt'); });
  } catch (err) {
    rootLogger.debug({ err }, 'Notify key auth lookup failed, falling through');
  }

  await next();
}

export function requireNotifyKey(c: AuthContext, next: Next) {
  // Accept notify key
  if (c.get('notifyKeyOrgId')) return next();

  // Also accept session auth with admin/editor role (for testing from UI)
  const role = c.get('role');
  if (c.get('userId') && (role === 'admin' || role === 'editor')) return next();

  throw new HTTPException(403, { message: 'Valid notify key required' });
}

export function generateNotifyKey(): { raw: string; prefix: string; hash: string } {
  const raw = NOTIFY_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const prefix = raw.slice(0, NOTIFY_KEY_PREFIX.length + 8);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, prefix, hash };
}
