/**
 * API key scope enforcement.
 * Ported from Verity's requireScope middleware.
 *
 * Cookie session bypass rules:
 *   admin / editor  → bypass all scope checks (full access)
 *   viewer          → bypass api:read only (read-only dashboard access)
 * API keys must carry the exact scope requested.
 */
import type { Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthContext } from '@sentinel/shared/hono-types';

export function requireScope(scope: string) {
  return (c: AuthContext, next: Next) => {
    const role = c.get('role');
    if (c.get('userId') && !c.get('apiKeyId')) {
      if (role === 'admin' || role === 'editor') return next();
      if (role === 'viewer' && scope === 'api:read') return next();
    }

    const scopes = c.get('scopes');
    if (scopes?.includes(scope)) return next();

    throw new HTTPException(403, { message: `Scope "${scope}" required` });
  };
}
