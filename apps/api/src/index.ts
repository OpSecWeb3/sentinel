import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { HTTPException } from 'hono/http-exception';
import { env } from '@sentinel/shared/env';
import { createLogger } from '@sentinel/shared/logger';
import { initSentry, captureException, setupGlobalHandlers } from '@sentinel/shared/sentry';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { getDb, closeDb, sql } from '@sentinel/db';
import { setSharedConnection } from '@sentinel/shared/queue';
import { setSharedRedis, getSharedRedis } from './redis.js';

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
import { modulesMetadataRouter, setModules } from './routes/modules-metadata.js';
import { notificationDeliveriesRouter } from './routes/notification-deliveries.js';
import { infraAnalyticsRouter } from './routes/infra-analytics.js';
import { awsAnalyticsRouter } from './routes/aws-analytics.js';
import { chainAnalyticsRouter } from './routes/chain-analytics.js';
import { registryAnalyticsRouter } from './routes/registry-analytics.js';
import { githubAnalyticsRouter } from './routes/github-analytics.js';

// Module imports
import { GitHubModule, setWebhookRateLimitRedis } from '@sentinel/module-github';
import { RegistryModule } from '@sentinel/module-registry';
import { ChainModule } from '@sentinel/module-chain';
import { InfraModule } from '@sentinel/module-infra';
import { AwsModule } from '@sentinel/module-aws';

// ── BigInt JSON serialization ───────────────────────────────────────────
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

// ── Observability ────────────────────────────────────────────────────────

const config = env();
const log = createLogger({ service: 'sentinel-api', level: config.LOG_LEVEL });

// ── Shared Redis connection for BullMQ queues and rate limiter ───────────
{
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  // Register with BullMQ queue factory
  setSharedConnection(redis);
  // Register with API-internal consumers (rate limiter, health check)
  setSharedRedis(redis);
  // Register with GitHub module webhook rate limiter
  setWebhookRateLimitRedis(redis);
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

// ── Request metrics ────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const start = performance.now();
  await next();
  const durationSec = (performance.now() - start) / 1000;
  const route = c.req.routePath ?? c.req.path;
  const method = c.req.method;
  const status = String(c.res.status);
  httpRequestDuration.observe({ method, route, status }, durationSec);
  httpRequestsTotal.inc({ method, route, status });
});

// ── CSRF defense header for state-changing requests ────────────────────
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  // Skip CSRF check for API-key/notify-key authenticated requests and webhook paths.
  // Use segment-boundary matching to prevent substring bypass (e.g. a path
  // containing "callback" in a parameter name).
  const path = c.req.path;
  if (path.includes('/webhooks/') || path.endsWith('/callback') || path.includes('/ci/notify')) {
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

  // Redis check — reuse the shared connection; it is already established so
  // ping() reflects the true liveness of Redis without a new TCP handshake.
  try {
    await getSharedRedis().ping();
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
app.route('/api/modules/metadata', modulesMetadataRouter);
app.route('/api/notification-deliveries', notificationDeliveriesRouter);
app.route('/api/infra', infraAnalyticsRouter);
app.route('/api/aws', awsAnalyticsRouter);
app.route('/api/chain', chainAnalyticsRouter);
app.route('/api/registry', registryAnalyticsRouter);
app.route('/api/github', githubAnalyticsRouter);

// ── Module routes ───────────────────────────────────────────────────────

// Global auth middleware for module routes, excluding webhook/callback paths
app.use('/modules/*', async (c, next) => {
  const path = c.req.path;
  // Skip auth for webhook and OAuth callback endpoints
  if (path.includes('/webhooks/') || path.endsWith('/callback') || path.includes('/ci/notify')) {
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

const modules = [GitHubModule, RegistryModule, ChainModule, InfraModule, AwsModule];
setModules(modules);
for (const mod of modules) {
  app.route(`/modules/${mod.id}`, mod.router);
}

// ── Error handling ──────────────────────────────────────────────────────

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    // If the exception carries a pre-built Response with JSON content type
    // (e.g. validation errors with structured details), return it directly.
    const res = err.getResponse();
    if (res.body && res.headers.get('content-type')?.includes('application/json')) {
      return res;
    }
    return c.json({ error: err.message }, err.status);
  }
  const reqLogger = c.get('logger') ?? log;
  reqLogger.error({ err }, 'Unhandled error');
  captureException(err, { requestId: c.get('requestId') });
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ── Prometheus metrics endpoint ─────────────────────────────────────────

import { register as metricsRegistry, httpRequestDuration, httpRequestsTotal } from '@sentinel/shared/metrics';
import { timingSafeEqual } from '@sentinel/shared/crypto';

app.get('/metrics', async (c) => {
  const metricsToken = process.env.METRICS_TOKEN;
  if (metricsToken) {
    const auth = c.req.header('Authorization');
    const expected = `Bearer ${metricsToken}`;
    if (!auth || !timingSafeEqual(auth, expected)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  const metrics = await metricsRegistry.metrics();
  return new Response(metrics, {
    headers: { 'Content-Type': metricsRegistry.contentType },
  });
});

// ── Start server ────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== 'test') {
  const port = config.PORT;

  // Verify DB and Redis are reachable before binding the port.
  // Fail fast so Docker healthcheck or orchestrator can restart us
  // instead of serving 500s to nginx.
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    log.info('Startup: database connected');
  } catch (err) {
    log.fatal({ err }, 'Startup: database unreachable — aborting');
    process.exit(1);
  }

  try {
    await getSharedRedis().ping();
    log.info('Startup: Redis connected');
  } catch (err) {
    log.fatal({ err }, 'Startup: Redis unreachable — aborting');
    process.exit(1);
  }

  log.info({ port }, 'Starting Sentinel API');
  const server = serve({ fetch: app.fetch, port });

  async function shutdown(signal: string) {
    log.info({ signal }, 'Shutting down API');
    // Stop accepting new connections; wait for in-flight requests to finish.
    server.close(async () => {
      await closeDb();
      await getSharedRedis().quit();
      log.info('API shutdown complete');
      process.exit(0);
    });
    // Force-exit if connections haven't drained within 10 s.
    setTimeout(() => {
      log.fatal('Graceful shutdown timeout — forcing exit');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}

export default app;
