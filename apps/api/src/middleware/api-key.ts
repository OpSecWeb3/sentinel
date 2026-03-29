import crypto from 'node:crypto';
import type { Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthContext } from '@sentinel/shared/hono-types';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { getDb } from '@sentinel/db';
import { apiKeys, orgMemberships } from '@sentinel/db/schema/core';
import { eq, and } from '@sentinel/db';

const KEY_PREFIX = 'sk_';

export async function apiKeyMiddleware(c: AuthContext, next: Next) {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith(`Bearer ${KEY_PREFIX}`)) return next();

  const rawKey = auth.slice(7); // Remove "Bearer "
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const db = getDb();
  // Look up by the unique keyHash index — avoids prefix-collision issues
  // where two non-revoked keys sharing the same 8-char prefix caused LIMIT 1
  // to return the wrong row.
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(
      eq(apiKeys.keyHash, keyHash),
      eq(apiKeys.revoked, false),
    ))
    .limit(1);

  if (!key || !key.keyHash) {
    throw new HTTPException(401, { message: 'Invalid API key' });
  }

  // Timing-safe hash comparison
  const hashBuffer = Buffer.from(keyHash, 'hex');
  const storedBuffer = Buffer.from(key.keyHash, 'hex');
  if (hashBuffer.length !== storedBuffer.length || !crypto.timingSafeEqual(hashBuffer, storedBuffer)) {
    throw new HTTPException(401, { message: 'Invalid API key' });
  }

  if (key.expiresAt && key.expiresAt <= new Date()) {
    throw new HTTPException(401, { message: 'API key expired' });
  }

  // Look up the user's org membership role — key is only valid if the
  // user is still an active member of the org the key was issued for.
  const [membership] = await db
    .select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, key.userId), eq(orgMemberships.orgId, key.orgId)))
    .limit(1);

  if (!membership) {
    throw new HTTPException(401, { message: 'Invalid API key' });
  }

  c.set('userId', key.userId);
  c.set('orgId', key.orgId);
  c.set('apiKeyId', key.id);
  c.set('scopes', key.scopes as string[]);
  c.set('role', membership.role);

  // Fire-and-forget last_used_at update
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .catch((err) => { rootLogger.debug({ err, apiKeyId: key.id }, 'Failed to update apiKey lastUsedAt'); });

  await next();
}
