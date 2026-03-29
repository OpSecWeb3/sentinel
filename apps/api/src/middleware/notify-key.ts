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
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  try {
    const db = getDb();

    // Look up by hash directly — avoids prefix-collision issues where two
    // orgs sharing the same 8-char prefix caused LIMIT 1 to return the wrong row.
    const [org] = await db.select({ id: organizations.id, notifyKeyHash: organizations.notifyKeyHash })
      .from(organizations)
      .where(eq(organizations.notifyKeyHash, keyHash))
      .limit(1);

    if (!org?.notifyKeyHash) throw new HTTPException(401, { message: 'Invalid notify key' });
    const hashBuffer = Buffer.from(keyHash, 'hex');
    const storedBuffer = Buffer.from(org.notifyKeyHash, 'hex');
    if (hashBuffer.length !== storedBuffer.length || !crypto.timingSafeEqual(hashBuffer, storedBuffer)) {
      throw new HTTPException(401, { message: 'Invalid notify key' });
    }

    c.set('notifyKeyOrgId', org.id);

    // Update last_used_at — awaited so errors propagate to the global handler
    // instead of being silently swallowed by a detached promise.
    await db.update(organizations)
      .set({ notifyKeyLastUsedAt: new Date() })
      .where(eq(organizations.id, org.id))
      .catch((err) => { rootLogger.warn({ err, orgId: org.id }, 'Failed to update notifyKey lastUsedAt'); });
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    rootLogger.error({ err }, 'Notify key auth lookup failed unexpectedly');
    throw new HTTPException(500, { message: 'Internal authentication error' });
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
