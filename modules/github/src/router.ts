/**
 * GitHub module Hono router.
 * Handles webhook reception, installation management, repo sync,
 * and GitHub App OAuth installation callback flow.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import crypto, { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from '@sentinel/db';
import { githubInstallations, githubRepositories } from '@sentinel/db/schema/github';
import { eq, and } from '@sentinel/db';
import { decrypt, encrypt, generateApiKey } from '@sentinel/shared/crypto';
import { env } from '@sentinel/shared/env';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { getClientIp } from '@sentinel/shared/ip';
import { getInstallationDetails } from './github-api.js';
import { syncOptionsSchema } from './sync.js';
import type IORedis from 'ioredis';

export const githubRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Redis-backed rate limiter for webhook endpoint.
// Uses the shared Redis connection injected via setWebhookRateLimitRedis()
// so that limits are enforced across all worker processes. Falls back to an
// in-memory Map only in test/development when Redis is unavailable.
// ---------------------------------------------------------------------------

let _rateLimitRedis: IORedis | undefined;

/** Call once at startup (from the API entrypoint) to share the Redis connection. */
export function setWebhookRateLimitRedis(redis: IORedis): void {
  _rateLimitRedis = redis;
}

const WEBHOOK_RATE_LIMIT = 100;
const WEBHOOK_RATE_WINDOW_SEC = 60;

const _inMemoryFallback = new Map<string, { count: number; resetAt: number }>();

async function isWebhookRateLimited(ip: string): Promise<boolean> {
  if (process.env.DISABLE_RATE_LIMIT === 'true') return false;

  const redis = _rateLimitRedis;
  if (redis) {
    // Atomic INCR + EXPIRE in a single round-trip (same pattern as API rate limiter)
    const luaScript = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return current
    `;
    const key = `sentinel:rl:gh-webhook:ip:${ip}`;
    const current = (await redis.eval(luaScript, 1, key, WEBHOOK_RATE_WINDOW_SEC)) as number;
    return current > WEBHOOK_RATE_LIMIT;
  }

  // Fallback: in-memory limiter for tests / local dev without Redis
  const now = Date.now();
  const entry = _inMemoryFallback.get(ip);
  if (!entry || now >= entry.resetAt) {
    _inMemoryFallback.set(ip, { count: 1, resetAt: now + WEBHOOK_RATE_WINDOW_SEC * 1000 });
    return false;
  }
  entry.count++;
  return entry.count > WEBHOOK_RATE_LIMIT;
}

// ---------------------------------------------------------------------------
// State signing for OAuth CSRF protection (same pattern as Slack flow)
// ---------------------------------------------------------------------------

function signState(payload: string): string {
  return crypto.createHmac('sha256', env().SESSION_SECRET).update(payload).digest('hex');
}

function verifyState(payload: string, signature: string): boolean {
  const expected = signState(payload);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

const MAX_STATE_AGE_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// GET /modules/github/app/callback — GitHub App installation OAuth callback
// (Public route — GitHub redirects here; must be before auth middleware)
// ---------------------------------------------------------------------------

githubRouter.get('/app/callback', async (c) => {
  const firstOrigin = env().ALLOWED_ORIGINS.split(',')[0]?.trim();
  if (!firstOrigin) {
    throw new Error('ALLOWED_ORIGINS env var is empty — cannot determine redirect URL for GitHub callback');
  }
  const webUrl = firstOrigin;

  const installationIdParam = c.req.query('installation_id');
  const stateParam = c.req.query('state');
  const setupAction = c.req.query('setup_action'); // 'install' | 'update'

  if (!installationIdParam || !stateParam) {
    return c.redirect(`${webUrl}/settings/github?status=error&reason=missing_params`);
  }

  // Parse and verify state (base64url payload + '.' + HMAC hex signature)
  const dotIdx = stateParam.lastIndexOf('.');
  if (dotIdx === -1) {
    return c.redirect(`${webUrl}/settings/github?status=error&reason=invalid_state`);
  }

  const stateB64 = stateParam.slice(0, dotIdx);
  const stateSig = stateParam.slice(dotIdx + 1);

  let statePayload: string;
  try {
    statePayload = Buffer.from(stateB64, 'base64url').toString();
  } catch {
    return c.redirect(`${webUrl}/settings/github?status=error&reason=invalid_state`);
  }

  if (!verifyState(statePayload, stateSig)) {
    return c.redirect(`${webUrl}/settings/github?status=error&reason=invalid_signature`);
  }

  const oauthStateSchema = z.object({
    orgId: z.string(),
    userId: z.string(),
    ts: z.number(),
  });

  let parsedState: z.infer<typeof oauthStateSchema>;
  try {
    parsedState = oauthStateSchema.parse(JSON.parse(statePayload));
  } catch {
    return c.redirect(`${webUrl}/settings/github?status=error&reason=invalid_state`);
  }

  const { orgId, userId, ts } = parsedState;

  if (Date.now() - ts > MAX_STATE_AGE_MS) {
    return c.redirect(`${webUrl}/settings/github?status=error&reason=expired_state`);
  }

  // Fetch installation details from GitHub API
  const installationIdNum = Number(installationIdParam);
  if (!Number.isFinite(installationIdNum) || installationIdNum <= 0) {
    return c.redirect(`${webUrl}/settings/github?status=error&reason=invalid_installation_id`);
  }

  let details;
  try {
    details = await getInstallationDetails(installationIdNum);
  } catch (err) {
    const reqLog = c.get('logger');
    reqLog.error({ err }, 'Failed to fetch GitHub installation details');
    return c.redirect(`${webUrl}/settings/github?status=error&reason=github_api_error`);
  }

  // Generate a unique webhook secret for this installation and encrypt it
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const encryptedSecret = encrypt(webhookSecret);

  // Store in github_installations table (upsert on installation_id)
  const db = getDb();
  const [installation] = await db.insert(githubInstallations).values({
    orgId,
    installationId: BigInt(details.id),
    appSlug: details.app_slug,
    targetType: details.target_type,
    targetLogin: details.account.login,
    targetId: BigInt(details.account.id),
    webhookSecretEncrypted: encryptedSecret,
    permissions: details.permissions,
    events: details.events,
    status: 'active',
  }).onConflictDoUpdate({
    target: githubInstallations.installationId,
    set: {
      orgId,
      appSlug: details.app_slug,
      targetType: details.target_type,
      targetLogin: details.account.login,
      targetId: BigInt(details.account.id),
      webhookSecretEncrypted: encryptedSecret,
      permissions: details.permissions,
      events: details.events,
      status: 'active',
    },
  }).returning();

  // Auto-trigger a repo sync job
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await queue.add('github.repo.sync', {
    installationId: installation.id,
    orgId,
    ghInstallationId: details.id,
  });

  return c.redirect(
    `${webUrl}/settings/github?status=success&installation_id=${installation.id}&action=${setupAction ?? 'install'}`,
  );
});

// ---------------------------------------------------------------------------
// GET /modules/github/app/install — returns the GitHub App installation URL
// (Authenticated — creates HMAC-signed state)
// ---------------------------------------------------------------------------

githubRouter.get('/app/install', async (c) => {
  const clientId = env().GITHUB_APP_CLIENT_ID;
  const appSlug = env().GITHUB_APP_SLUG;
  if (!clientId || !appSlug) {
    return c.json({ error: 'GitHub App not configured on this server' }, 501);
  }

  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const statePayload = JSON.stringify({ orgId, userId, ts: Date.now() });
  const stateB64 = Buffer.from(statePayload).toString('base64url');
  const stateSig = signState(statePayload);
  const state = `${stateB64}.${stateSig}`;

  // GitHub App installation URL includes state for CSRF protection
  const url = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;

  return c.json({ url });
});

// ---------------------------------------------------------------------------
// POST /modules/github/app/setup — manual installation for self-hosted GHE
// (Authenticated, admin only)
// ---------------------------------------------------------------------------

const manualSetupSchema = z.object({
  installationId: z.coerce.number().int().positive(),
  webhookSecret: z.string().min(20, 'Webhook secret must be at least 20 characters'),
  baseUrl: z.string().url().optional(), // for GitHub Enterprise Server
});

githubRouter.post('/app/setup', bodyLimit({ maxSize: 1 * 1024 * 1024 }), async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const body = manualSetupSchema.parse(await c.req.json());

  // Attempt to fetch installation details from GitHub API
  let details;
  try {
    details = await getInstallationDetails(body.installationId);
  } catch (err) {
    const reqLog = c.get('logger');
    reqLog.error({ err }, 'Failed to fetch GitHub installation details');
    return c.json({ error: 'Could not verify installation with GitHub API' }, 400);
  }

  // Encrypt the provided webhook secret
  const encryptedSecret = encrypt(body.webhookSecret);

  const db = getDb();
  const [installation] = await db.insert(githubInstallations).values({
    orgId,
    installationId: BigInt(details.id),
    appSlug: details.app_slug,
    targetType: details.target_type,
    targetLogin: details.account.login,
    targetId: BigInt(details.account.id),
    webhookSecretEncrypted: encryptedSecret,
    permissions: details.permissions,
    events: details.events,
    status: 'active',
  }).onConflictDoUpdate({
    target: githubInstallations.installationId,
    set: {
      orgId,
      appSlug: details.app_slug,
      targetType: details.target_type,
      targetLogin: details.account.login,
      targetId: BigInt(details.account.id),
      webhookSecretEncrypted: encryptedSecret,
      permissions: details.permissions,
      events: details.events,
      status: 'active',
    },
  }).returning();

  // Auto-trigger a repo sync job
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await queue.add('github.repo.sync', {
    installationId: installation.id,
    orgId,
    ghInstallationId: details.id,
  });

  return c.json({
    data: {
      id: installation.id,
      installationId: Number(installation.installationId),
      targetLogin: installation.targetLogin,
      targetType: installation.targetType,
    },
  }, 201);
});

// ---------------------------------------------------------------------------
// POST /modules/github/webhooks/:installationId — receive GitHub webhooks
// ---------------------------------------------------------------------------

githubRouter.post(
  '/webhooks/:installationId',
  // CRIT-11: Enforce a hard 5 MB body limit regardless of whether Content-Length
  // is present. The previous guard (`if (contentLength && ...)`) was skipped when
  // the header was absent, allowing unbounded body reads via c.req.text().
  // bodyLimit streams the body and aborts if the byte count exceeds maxSize,
  // covering both the header-present fast-path and the chunked/no-header path.
  bodyLimit({ maxSize: 5 * 1024 * 1024 }),
  async (c) => {
  const clientIp = getClientIp(c);
  if (await isWebhookRateLimited(clientIp)) {
    return c.json({ error: 'Too many requests' }, 429);
  }

  const installationId = c.req.param('installationId');
  const signature = c.req.header('X-Hub-Signature-256');
  const eventType = c.req.header('X-GitHub-Event');
  const deliveryId = c.req.header('X-GitHub-Delivery');

  if (!signature || !eventType || !deliveryId) {
    return c.json({ error: 'Missing required GitHub webhook headers' }, 400);
  }

  const db = getDb();

  // Load installation
  const [installation] = await db.select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationId))
    .limit(1);

  // Fix #7: Prevent installation ID enumeration.
  // If installation not found, perform a dummy HMAC and return 401 (same as bad signature)
  // so that attackers cannot distinguish "not found" from "bad signature".
  if (!installation || installation.status !== 'active') {
    const dummySecret = crypto.randomBytes(32).toString('hex');
    createHmac('sha256', dummySecret).update('dummy').digest('hex');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Verify HMAC-SHA256 signature
  const rawBody = await c.req.text();
  const secret = decrypt(installation.webhookSecretEncrypted);
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

  const sigBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Fix #17: Safely parse JSON body
  let parsedPayload: Record<string, unknown>;
  try {
    parsedPayload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Fix #9: Use deliveryId as BullMQ jobId to deduplicate retried webhooks
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await queue.add('github.webhook.process', {
    deliveryId,
    eventType,
    payload: parsedPayload,
    installationId: installation.id,
    orgId: installation.orgId,
  }, {
    jobId: `gh-webhook-${deliveryId}`,
  });

  return c.json({ received: true }, 202);
});

// ---------------------------------------------------------------------------
// Authenticated routes — require auth context from parent middleware
// ---------------------------------------------------------------------------

// GET /modules/github/installations — list installations for org
const installationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

githubRouter.get('/installations', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const rawQuery = c.req.query();
  const query = installationsQuerySchema.parse(rawQuery);

  const db = getDb();
  const installations = await db.select({
    id: githubInstallations.id,
    installationId: githubInstallations.installationId,
    targetLogin: githubInstallations.targetLogin,
    targetType: githubInstallations.targetType,
    status: githubInstallations.status,
    permissions: githubInstallations.permissions,
    events: githubInstallations.events,
    createdAt: githubInstallations.createdAt,
  })
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({ data: installations, limit: query.limit, offset: query.offset });
});

// POST /modules/github/installations — register a new GitHub App installation
const createInstallationSchema = z.object({
  installationId: z.coerce.number().int().positive(),
  appSlug: z.string().min(1),
  targetType: z.enum(['Organization', 'User']),
  targetLogin: z.string().min(1),
  targetId: z.coerce.number().int().positive(),
  webhookSecret: z.string().min(20, 'Webhook secret must be at least 20 characters'),
  permissions: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).default([]),
});

githubRouter.post('/installations', bodyLimit({ maxSize: 1 * 1024 * 1024 }), async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const body = createInstallationSchema.parse(await c.req.json());
  const db = getDb();

  // Encrypt the webhook secret
  const encryptedSecret = encrypt(body.webhookSecret);

  const [installation] = await db.insert(githubInstallations).values({
    orgId,
    installationId: BigInt(body.installationId),
    appSlug: body.appSlug,
    targetType: body.targetType,
    targetLogin: body.targetLogin,
    targetId: BigInt(body.targetId),
    webhookSecretEncrypted: encryptedSecret,
    permissions: body.permissions,
    events: body.events,
  }).returning();

  // Fix #14: Auto-trigger repo sync after manual installation creation
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await queue.add('github.repo.sync', {
    installationId: installation.id,
    orgId,
    ghInstallationId: body.installationId,
  });

  return c.json({ data: { id: installation.id, installationId: installation.installationId } }, 201);
});

// DELETE /modules/github/installations/:id — remove installation
githubRouter.delete('/installations/:id', async (c) => {
  const installationId = c.req.param('id');
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const db = getDb();

  const [result] = await db.update(githubInstallations)
    .set({ status: 'removed' })
    .where(and(eq(githubInstallations.id, installationId), eq(githubInstallations.orgId, orgId)))
    .returning({ id: githubInstallations.id });

  if (!result) return c.json({ error: 'Installation not found' }, 404);
  return c.json({ data: { id: result.id, status: 'removed' } });
});

// GET /modules/github/repositories — list tracked repos
const repositoriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

githubRouter.get('/repositories', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const rawQuery = c.req.query();
  const query = repositoriesQuerySchema.parse(rawQuery);

  const db = getDb();
  const repos = await db.select()
    .from(githubRepositories)
    .where(eq(githubRepositories.orgId, orgId))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({ data: repos, limit: query.limit, offset: query.offset });
});

// POST /modules/github/installations/:id/sync — trigger a filtered repo sync
githubRouter.post('/installations/:id/sync', bodyLimit({ maxSize: 1 * 1024 * 1024 }), async (c) => {
  const installationId = c.req.param('id');
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const body = syncOptionsSchema.parse(await c.req.json().catch(() => ({})));
  const db = getDb();

  // Verify the installation belongs to this org
  const [installation] = await db.select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(and(eq(githubInstallations.id, installationId), eq(githubInstallations.orgId, orgId)))
    .limit(1);

  if (!installation) return c.json({ error: 'Installation not found' }, 404);

  // Fix #8: Use installationId-based jobId to deduplicate concurrent sync requests
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  const job = await queue.add('github.repo.sync', {
    installationId: installation.id,
    orgId,
    options: body,
  }, {
    jobId: `gh-repo-sync-${installation.id}`,
  });

  return c.json({ data: { jobId: job.id, status: 'queued' } }, 202);
});

// GET /modules/github/templates — list available detection templates
githubRouter.get('/templates', async (c) => {
  // Import templates from the module
  const { templates } = await import('./templates/index.js');
  return c.json({ data: templates });
});

// GET /modules/github/event-types — list event types this module handles
githubRouter.get('/event-types', async (c) => {
  const { eventTypes } = await import('./event-types.js');
  return c.json({ data: eventTypes });
});
