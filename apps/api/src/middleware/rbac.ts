import type { Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthContext } from '@sentinel/shared/hono-types';

export function requireAuth(c: AuthContext, next: Next) {
  if (!c.get('userId')) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }
  return next();
}

export function requireOrg(c: AuthContext, next: Next) {
  if (!c.get('orgId')) {
    throw new HTTPException(403, { message: 'Organisation membership required' });
  }
  return next();
}

export function requireRole(...roles: string[]) {
  return (c: AuthContext, next: Next) => {
    if (!c.get('userId')) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }
    if (!c.get('orgId')) {
      throw new HTTPException(403, { message: 'Organisation membership required' });
    }
    const role = c.get('role');
    if (!role || !roles.includes(role)) {
      throw new HTTPException(403, { message: 'Insufficient permissions' });
    }
    return next();
  };
}
