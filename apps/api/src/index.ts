import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { HTTPException } from 'hono/http-exception';
import { env } from '@sentinel/shared/env';
import { createLogger } from '@sentinel/shared/logger';
import { initSentry, captureException, setupGlobalHandlers } from '@sentinel/shared/sentry';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { getDb, sql } from '@sentinel/db';
import { setSharedConnection } from '@sentinel/shared/queue';

import { requestContext, enrichLogger } from './middleware/request-context.js';
import { sessionMiddleware } from './middleware/session.js';
import { apiKeyMiddleware } from './middleware/api-key.js';
import { notifyKeyMiddleware } from './middleware/notify-key.js';
import { requireAuth, requireOrg } from './middleware/rbac.js';
import { apiReadLimiter, apiWriteLimiter } from './middleware/rate-limit.js';

import { authRouter } from './routes/auth.js';
import { detectionsRouter } from './routes/detections.js';
import { alertsRouter } from './routes/alerts.js';
import { channelsRouter } from './routes/channels.js';
import { integrationsRouter } from './routes/integrations.js';
import { eventsRouter } from './routes/events.js';
import { auditLogRouter } from './routes/audit-log.js';
import { correlationRulesRouter } from './routes/correlation-rules.js';

// Module imports
import { GitHubModule } from '@sentinel/module-github';
import { ReleaseChainModule } from '@sentinel/module-release-chain';
import { ChainModule } from '@sentinel/module-chain';
import { InfraModule } from '@sentinel/module-infra';

// ── BigInt JSON serialization ───────────────────────────────────────────
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

// ── Observability ────────────────────────────────────────────────────────

const config = env();
const log = createLogger({ service: 'sentinel-api', level: config.LOG_LEVEL });

// ── Shared Redis connection for BullMQ queues ────────────────────────────
{
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  setSharedConnection(redis);
}

await initSentry({
  dsn: config.SENTRY_DSN,
  service: 'sentinel-api',
  environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
});
setupGlobalHandlers(log);

// ── App ─────────────────────────────────────────────────────────────────

const app = new Hono<AppEnv>();

// ── Global middleware ───────────────────────────────────────────────────

app.use('*', requestContext(log));
app.use('*', cors({
  origin: config.ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Sentinel-Request'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  credentials: true,
  maxAge: 86400,
}));

// ── Security headers ───────────────────────────────────────────────────
app.use('*', async (c, next) => {
  await next();
  // HSTS is only meaningful (and safe) over HTTPS in production.
  // Sending it unconditionally with `preload` in non-TLS environments risks
  // permanently breaking HTTP access if the domain ends up on preload lists.
  if (process.env.NODE_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-XSS-Protection', '0');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

// ── CSRF defense header for state-changing requests ────────────────────
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  // Skip CSRF check for API-key/notify-key authenticated requests and webhook paths
  const path = c.req.path;
  if (path.includes('/webhooks/') || path.includes('/callback') || path.includes('/ci/notify')) {
    return next();
  }
  // If the request uses a Bearer token (API key / notify key), skip CSRF header check
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    return next();
  }
  // Only enforce CSRF header when a session cookie is present.
  // If there's no cookie, there's no CSRF attack vector to defend against.
  const { getCookie } = await import('hono/cookie');
  const sid = getCookie(c, 'sentinel.sid');
  if (!sid) {
    return next();
  }
  // Cookie-authenticated state-changing request: require the custom header
  const csrfHeader = c.req.header('X-Sentinel-Request');
  if (!csrfHeader) {
    throw new HTTPException(403, { message: 'Missing CSRF defense header: X-Sentinel-Request' });
  }
  return next();
});

app.use('*', sessionMiddleware);
app.use('*', apiKeyMiddleware);
app.use('*', notifyKeyMiddleware);
app.use('*', enrichLogger);

// ── Health check ────────────────────────────────────────────────────────

app.get('/health', async (c) => {
  const checks: Record<string, string> = { db: 'ok', redis: 'ok' };
  let healthy = true;

  // Database check — actually run a query to verify the connection is alive
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    log.debug({ err }, 'Health check: DB unreachable');
    checks.db = 'error';
    healthy = false;
  }

  // Redis check
  try {
    const IORedis = (await import('ioredis')).default;
    const redis = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
    });
    await redis.ping();
    await redis.quit();
  } catch (err) {
    log.debug({ err }, 'Health check: Redis unreachable');
    checks.redis = 'error';
    healthy = false;
  }

  const status = healthy ? 'ok' : 'degraded';
  return c.json({ status, ...checks, timestamp: new Date().toISOString() }, healthy ? 200 : 503);
});

// ── Public routes ───────────────────────────────────────────────────────

app.route('/auth', authRouter);

// ── Integration routes (callback is public, rest is authenticated) ──────

app.route('/integrations', integrationsRouter);

// ── Rate limiting on API routes ─────────────────────────────────────────

app.use('/api/*', async (c, next) => {
  if (c.req.method === 'GET') return apiReadLimiter(c, next);
  return apiWriteLimiter(c, next);
});

// ── Protected API routes ────────────────────────────────────────────────

app.route('/api/detections', detectionsRouter);
app.route('/api/alerts', alertsRouter);
app.route('/api/channels', channelsRouter);
app.route('/api/events', eventsRouter);
app.route('/api/audit-log', auditLogRouter);
app.route('/api/correlation-rules', correlationRulesRouter);

// ── Module routes ───────────────────────────────────────────────────────

// Global auth middleware for module routes, excluding webhook/callback paths
app.use('/modules/*', async (c, next) => {
  const path = c.req.path;
  // Skip auth for webhook and OAuth callback endpoints
  if (path.includes('/webhooks/') || path.includes('/callback') || path.includes('/ci/notify')) {
    return next();
  }
  if (!c.get('userId')) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }
  if (!c.get('orgId')) {
    throw new HTTPException(403, { message: 'Organisation membership required' });
  }
  return next();
});

const modules = [GitHubModule, ReleaseChainModule, ChainModule, InfraModule];
for (const mod of modules) {
  app.route(`/modules/${mod.id}`, mod.router);
}

// ── Error handling ──────────────────────────────────────────────────────

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  const reqLogger = c.get('logger') ?? log;
  reqLogger.error({ err }, 'Unhandled error');
  captureException(err, { requestId: c.get('requestId') });
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ── Start server ────────────────────────────────────────────────────────

const port = config.PORT;
log.info({ port }, 'Starting Sentinel API');

serve({ fetch: app.fetch, port });

export default app;
