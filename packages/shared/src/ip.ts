/**
 * Trusted client-IP derivation for rate limiting and audit logging.
 *
 * IP derivation rules:
 *   TRUSTED_PROXY_COUNT > 0  → read X-Forwarded-For at depth N from the right.
 *                               The reverse proxy (nginx) must be the sole writer
 *                               of XFF; client-supplied left-side entries are ignored.
 *   TRUSTED_PROXY_COUNT = 0  → use raw socket remoteAddress only. Never read
 *                               X-Real-IP or X-Forwarded-For, which a client can
 *                               forge when no proxy strips/overwrites them.
 */
import type { Context } from 'hono';

export function getClientIp(c: Context): string {
  const trustedProxyCount = parseInt(process.env.TRUSTED_PROXY_COUNT ?? '0', 10);

  if (trustedProxyCount > 0) {
    const forwarded = c.req.header('X-Forwarded-For');
    if (forwarded) {
      const parts = forwarded.split(',').map((s) => s.trim());
      // The entry at (length - trustedProxyCount) is the client IP as recorded
      // by the outermost trusted proxy, unaffected by client-supplied leading entries.
      const idx = Math.max(0, parts.length - trustedProxyCount);
      return parts[idx] ?? 'unknown';
    }
  }

  return (c.env as Record<string, unknown>)?.remoteAddress as string ?? 'unknown';
}
