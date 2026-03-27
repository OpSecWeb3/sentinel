import crypto from 'node:crypto';
import type { Next } from 'hono';
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
  const prefix = rawKey.slice(0, KEY_PREFIX.length + 8);
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const db = getDb();
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(
      eq(apiKeys.keyPrefix, prefix),
      eq(apiKeys.keyHash, hash),
      eq(apiKeys.revoked, false),
    ))
    .limit(1);

  if (key && (!key.expiresAt || key.expiresAt > new Date())) {
    // Look up the user's org membership role — key is only valid if the
    // user is still an active member of the org the key was issued for.
    const [membership] = await db
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.userId, key.userId), eq(orgMemberships.orgId, key.orgId)))
      .limit(1);

    if (!membership) {
      // User is no longer a member of this org — treat key as invalid.
      await next();
      return;
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
  }

  await next();
}
