/**
 * Request context middleware.
 * Assigns a unique request ID, creates a Pino child logger with
 * request bindings, and sets the X-Request-Id response header.
 */
import crypto from 'node:crypto';
import type { Next } from 'hono';
import type { AuthContext } from '@sentinel/shared/hono-types';
import type { Logger } from '@sentinel/shared/logger';

/**
 * Creates a middleware that injects requestId + child logger into context.
 */
export function requestContext(rootLogger: Logger) {
  return async (c: AuthContext, next: Next) => {
    const requestId = c.req.header('X-Request-Id') ?? crypto.randomUUID();
    const child = rootLogger.child({
      requestId,
      method: c.req.method,
      path: c.req.path,
    });

    c.set('requestId', requestId);
    c.set('logger', child);
    c.header('X-Request-Id', requestId);

    const start = performance.now();
    await next();
    const duration = Math.round(performance.now() - start);

    const status = c.res.status;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    child[level]({ status, durationMs: duration }, 'request completed');
  };
}

/**
 * Post-auth middleware to enrich the logger with user/org context.
 */
export function enrichLogger(c: AuthContext, next: Next) {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (orgId || userId) {
    const parent = c.get('logger');
    const enriched = parent.child({
      ...(orgId ? { orgId } : {}),
      ...(userId ? { userId } : {}),
    });
    c.set('logger', enriched);
  }
  return next();
}
