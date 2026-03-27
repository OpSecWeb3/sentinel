/**
 * Release-chain module Hono router.
 *
 * Handles Docker Hub / npm webhook reception, CI notification endpoint,
 * and CRUD for monitored images and packages.
 */
import { logger as rootLogger } from '@sentinel/shared/logger';
import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getDb } from '@sentinel/db';
import { organizations } from '@sentinel/db/schema/core';
import { rcArtifacts, rcArtifactVersions, rcArtifactEvents } from '@sentinel/db/schema/registry';
import { eq, and, desc } from '@sentinel/db';
import { encrypt, decrypt } from '@sentinel/shared/crypto';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import type { AppEnv, AuthContext } from '@sentinel/shared/hono-types';
import { searchNpmScope } from './npm-registry.js';
import { preflightTagCount } from './preflight.js';
import { templates as rcTemplates } from './templates/index.js';
import { count, sql } from '@sentinel/db';
import { detections, alerts } from '@sentinel/db/schema/core';

const log = rootLogger.child({ component: 'registry-router' });

export const registryRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Shared detail helper
// ---------------------------------------------------------------------------

async function getArtifactDetail(c: AuthContext, artifactType: string) {
  const orgId = c.get('orgId');
  const id = c.req.param('id')!;
  const db = getDb();

  const [artifact] = await db
    .select()
    .from(rcArtifacts)
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, artifactType),
    ))
    .limit(1);

  if (!artifact) {
    return c.json({ error: `${artifactType === 'docker_image' ? 'Image' : 'Package'} not found` }, 404);
  }

  const versions = await db
    .select()
    .from(rcArtifactVersions)
    .where(eq(rcArtifactVersions.artifactId, artifact.id))
    .orderBy(desc(rcArtifactVersions.createdAt));

  const recentEvents = await db
    .select()
    .from(rcArtifactEvents)
    .where(eq(rcArtifactEvents.artifactId, artifact.id))
    .orderBy(desc(rcArtifactEvents.createdAt))
    .limit(20);

  return c.json({
    data: {
      artifact: {
        ...artifact,
        hasCredentials: !!artifact.credentialsEncrypted,
        credentialsEncrypted: undefined,
      },
      versions,
      recentEvents,
    },
  });
}

// ---------------------------------------------------------------------------
// Update/delete schemas
// ---------------------------------------------------------------------------

const updateArtifactSchema = z.object({
  tagWatchPatterns: z.array(z.string()).optional(),
  tagIgnorePatterns: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  pollIntervalSeconds: z.coerce.number().int().min(60).optional(),
  githubRepo: z.string().nullable().optional(),
  webhookUrl: z.string().url().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Verify HMAC-SHA256 signature on an incoming webhook body.
 */
function verifyHmacSha256(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/**
 * Authenticate a CI notification request using the org's notify key.
 * The key is sent as a Bearer token. We hash it and compare to the stored hash.
 */
async function authenticateNotifyKey(
  authHeader: string | undefined,
): Promise<{ orgId: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;

  const raw = authHeader.slice(7);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');

  const db = getDb();
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.notifyKeyHash, hash))
    .limit(1);

  if (!org) return null;

  // Update last-used timestamp (fire-and-forget)
  db.update(organizations)
    .set({ notifyKeyLastUsedAt: new Date() })
    .where(eq(organizations.id, org.id))
    .then(() => {}, () => {});

  return { orgId: org.id };
}

/**
 * Safely enqueue a job. On failure (e.g. Redis down), returns null.
 */
async function safeEnqueue(
  queueName: string,
  jobName: string,
  data: Record<string, unknown>,
): Promise<{ id?: string } | null> {
  try {
    const queue = getQueue(queueName);
    return await queue.add(jobName, data);
  } catch (err) {
    log.error({ err, jobName }, 'Failed to enqueue job');
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /modules/registry/webhooks/docker
// Docker Hub webhook receiver with HMAC-SHA256 verification.
// ---------------------------------------------------------------------------

registryRouter.post('/webhooks/docker', async (c) => {
  const signature = c.req.header('X-Hub-Signature-256')?.replace('sha256=', '')
    ?? c.req.header('X-Signature')?.replace('sha256=', '');

  if (!signature) {
    return c.json({ error: 'Missing webhook signature header' }, 400);
  }

  const rawBody = await c.req.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Extract repo name from payload to find the owning org
  const repoName = (payload.repository as Record<string, unknown>)?.repo_name as string | undefined;
  if (!repoName) {
    return c.json({ error: 'Invalid Docker Hub webhook payload' }, 400);
  }

  const db = getDb();

  // Fix #7: Look up the artifact by repo_name first to find the owning org,
  // then verify only that org's secret.
  const [artifact] = await db
    .select({ orgId: rcArtifacts.orgId })
    .from(rcArtifacts)
    .where(eq(rcArtifacts.name, repoName))
    .limit(1);

  let matchedOrgId: string | null = null;

  if (artifact) {
    // We know the owning org -- verify only their secret
    const [org] = await db
      .select({
        id: organizations.id,
        webhookSecretEncrypted: organizations.webhookSecretEncrypted,
      })
      .from(organizations)
      .where(eq(organizations.id, artifact.orgId))
      .limit(1);

    if (org?.webhookSecretEncrypted) {
      try {
        const secret = decrypt(org.webhookSecretEncrypted);
        if (verifyHmacSha256(rawBody, signature, secret)) {
          matchedOrgId = org.id;
        }
      } catch (err) {
        log.debug({ err, orgId: org.id }, 'Docker webhook secret decryption failed');
      }
    }
  }

  // Fallback: if artifact not found in DB (e.g. first webhook before monitoring
  // is configured), iterate orgs as before but limit scope
  if (!matchedOrgId && !artifact) {
    const orgs = await db
      .select({
        id: organizations.id,
        webhookSecretEncrypted: organizations.webhookSecretEncrypted,
      })
      .from(organizations);

    for (const org of orgs) {
      if (!org.webhookSecretEncrypted) continue;

      try {
        const secret = decrypt(org.webhookSecretEncrypted);
        if (verifyHmacSha256(rawBody, signature, secret)) {
          matchedOrgId = org.id;
          break;
        }
      } catch (err) {
        log.debug({ err, orgId: org.id }, 'Docker webhook secret decryption failed during fallback');
        continue;
      }
    }
  }

  if (!matchedOrgId) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  // Fix #10: Enqueue with try-catch, return 503 on failure
  const job = await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'registry.webhook.process', {
    source: 'docker',
    payload,
    orgId: matchedOrgId,
    externalId: c.req.header('X-Request-Id') ?? null,
  });

  if (!job) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  return c.json({ received: true }, 202);
});

// ---------------------------------------------------------------------------
// POST /modules/registry/webhooks/npm
// npm registry webhook receiver.
// npm hooks use HMAC-SHA256 in the x-npm-signature header.
// ---------------------------------------------------------------------------

registryRouter.post('/webhooks/npm', async (c) => {
  const signature = c.req.header('x-npm-signature')?.replace('sha256=', '');

  if (!signature) {
    return c.json({ error: 'Missing npm webhook signature header' }, 400);
  }

  const rawBody = await c.req.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const packageName = payload.name as string | undefined;
  if (!packageName) {
    return c.json({ error: 'Invalid npm webhook payload' }, 400);
  }

  const db = getDb();

  // Fix #7: Look up artifact by package name first to find owning org
  const [artifact] = await db
    .select({ orgId: rcArtifacts.orgId })
    .from(rcArtifacts)
    .where(eq(rcArtifacts.name, packageName))
    .limit(1);

  let matchedOrgId: string | null = null;

  if (artifact) {
    const [org] = await db
      .select({
        id: organizations.id,
        webhookSecretEncrypted: organizations.webhookSecretEncrypted,
      })
      .from(organizations)
      .where(eq(organizations.id, artifact.orgId))
      .limit(1);

    if (org?.webhookSecretEncrypted) {
      try {
        const secret = decrypt(org.webhookSecretEncrypted);
        if (verifyHmacSha256(rawBody, signature, secret)) {
          matchedOrgId = org.id;
        }
      } catch (err) {
        log.debug({ err, orgId: org.id }, 'npm webhook secret decryption failed');
      }
    }
  }

  // Fallback for unregistered artifacts
  if (!matchedOrgId && !artifact) {
    const orgs = await db
      .select({
        id: organizations.id,
        webhookSecretEncrypted: organizations.webhookSecretEncrypted,
      })
      .from(organizations);

    for (const org of orgs) {
      if (!org.webhookSecretEncrypted) continue;

      try {
        const secret = decrypt(org.webhookSecretEncrypted);
        if (verifyHmacSha256(rawBody, signature, secret)) {
          matchedOrgId = org.id;
          break;
        }
      } catch (err) {
        log.debug({ err, orgId: org.id }, 'npm webhook secret decryption failed during fallback');
        continue;
      }
    }
  }

  if (!matchedOrgId) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  // Fix #10: Enqueue with try-catch, return 503 on failure
  const job = await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'registry.webhook.process', {
    source: 'npm',
    payload,
    orgId: matchedOrgId,
    externalId: c.req.header('x-npm-delivery') ?? null,
  });

  if (!job) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  return c.json({ received: true }, 202);
});

// ---------------------------------------------------------------------------
// POST /modules/registry/ci/notify
// CI notification endpoint for GitHub Actions to report what it pushed.
// Authenticated via notify key (Bearer token).
// ---------------------------------------------------------------------------

const ciNotificationSchema = z.object({
  image: z.string().min(1),
  tag: z.string().min(1),
  digest: z.string().min(1),
  runId: z.coerce.number().int().positive(),
  commit: z.string().min(7),
  actor: z.string().min(1),
  workflow: z.string().min(1),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
});

registryRouter.post('/ci/notify', async (c) => {
  // Authenticate using notify key
  const auth = await authenticateNotifyKey(c.req.header('Authorization'));
  if (!auth) {
    return c.json({ error: 'Invalid or missing notify key' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = ciNotificationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid payload', details: parsed.error.flatten() }, 400);
  }

  // Fix #10: Enqueue with try-catch, return 503 on failure
  const job = await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'registry.ci.process', {
    notification: parsed.data,
    orgId: auth.orgId,
  });

  if (!job) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  return c.json({ received: true, jobId: job.id }, 202);
});

// ---------------------------------------------------------------------------
// Authenticated routes -- require auth context from parent middleware
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /modules/registry/images -- list monitored Docker images
// ---------------------------------------------------------------------------

registryRouter.get('/images', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const artifacts = await db
    .select()
    .from(rcArtifacts)
    .where(and(eq(rcArtifacts.orgId, orgId), eq(rcArtifacts.artifactType, 'docker_image')))
    .orderBy(desc(rcArtifacts.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data: artifacts.map(({ credentialsEncrypted, ...rest }) => ({ ...rest, hasCredentials: !!credentialsEncrypted })) });
});

// ---------------------------------------------------------------------------
// POST /modules/registry/images -- add Docker image to monitor
// ---------------------------------------------------------------------------

const addImageSchema = z.object({
  name: z.string().min(1).describe('Docker image name, e.g. "library/nginx"'),
  tagPatterns: z.array(z.string()).default(['*']),
  ignorePatterns: z.array(z.string()).default([]),
  pollIntervalSeconds: z.coerce.number().int().min(60).default(300),
  githubRepo: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
});

registryRouter.post('/images', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const body = addImageSchema.parse(await c.req.json());

  // Pre-flight: skip when specific tagPatterns are set (user has scoped it already)
  const hasSpecificPatterns = body.tagPatterns.length > 0 && !body.tagPatterns.every((p: string) => p === '*');
  if (!hasSpecificPatterns) {
    try {
      const preflight = await preflightTagCount('docker_hub', body.name);
      if (!preflight.ok) {
        return c.json({ error: preflight.message, totalCount: preflight.totalCount }, 400);
      }
    } catch (err) {
      log.warn({ err, artifactName: body.name }, 'Preflight check failed');
    }
  }

  // Fix #10: Enqueue with try-catch
  const job = await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'registry.poll', {
    artifact: {
      id: crypto.randomUUID(),
      orgId,
      name: body.name,
      registry: 'docker_hub',
      enabled: true,
      tagPatterns: body.tagPatterns,
      ignorePatterns: body.ignorePatterns,
      pollIntervalSeconds: body.pollIntervalSeconds,
      lastPolledAt: null,
      storedVersions: {},
      metadata: {},
    },
  });

  if (!job) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  return c.json(
    {
      data: {
        name: body.name,
        registry: 'docker_hub',
        tagPatterns: body.tagPatterns,
        pollIntervalSeconds: body.pollIntervalSeconds,
        jobId: job.id,
      },
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET /modules/registry/images/:id -- Docker image detail
// ---------------------------------------------------------------------------

registryRouter.get('/images/:id', async (c) => {
  return getArtifactDetail(c, 'docker_image');
});

// ---------------------------------------------------------------------------
// PUT /modules/registry/images/:id -- update Docker image config
// ---------------------------------------------------------------------------

registryRouter.put('/images/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin' && role !== 'editor') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = c.req.param('id')!;
  const body = await c.req.json();
  const parsed = updateArtifactSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);

  const db = getDb();
  const [updated] = await db
    .update(rcArtifacts)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, 'docker_image'),
    ))
    .returning();

  if (!updated) return c.json({ error: 'Image not found' }, 404);
  const { credentialsEncrypted: _creds, ...safeUpdated } = updated;
  return c.json({ data: { ...safeUpdated, hasCredentials: !!_creds } });
});

// ---------------------------------------------------------------------------
// DELETE /modules/registry/images/:id -- soft-delete Docker image
// ---------------------------------------------------------------------------

registryRouter.delete('/images/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id')!;
  const db = getDb();
  const [updated] = await db
    .update(rcArtifacts)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, 'docker_image'),
    ))
    .returning({ id: rcArtifacts.id });

  if (!updated) return c.json({ error: 'Image not found' }, 404);
  return c.json({ status: 'ok', id: updated.id });
});

// ---------------------------------------------------------------------------
// GET /modules/registry/packages -- list monitored npm packages
// ---------------------------------------------------------------------------

registryRouter.get('/packages', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const artifacts = await db
    .select()
    .from(rcArtifacts)
    .where(and(eq(rcArtifacts.orgId, orgId), eq(rcArtifacts.artifactType, 'npm_package')))
    .orderBy(desc(rcArtifacts.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data: artifacts.map(({ credentialsEncrypted, ...rest }) => ({ ...rest, hasCredentials: !!credentialsEncrypted })) });
});

// ---------------------------------------------------------------------------
// POST /modules/registry/packages -- add npm package to monitor
// ---------------------------------------------------------------------------

const addPackageSchema = z.object({
  name: z.string().min(1).describe('npm package name, e.g. "@acme/sdk"'),
  tagPatterns: z.array(z.string()).default(['*']),
  ignorePatterns: z.array(z.string()).default([]),
  pollIntervalSeconds: z.coerce.number().int().min(60).default(300),
  githubRepo: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
});

registryRouter.post('/packages', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const body = addPackageSchema.parse(await c.req.json());

  // Pre-flight: skip when specific tagPatterns are set (user has scoped it already)
  const hasSpecificPatterns = body.tagPatterns.length > 0 && !body.tagPatterns.every((p: string) => p === '*');
  if (!hasSpecificPatterns) {
    try {
      const preflight = await preflightTagCount('npmjs', body.name);
      if (!preflight.ok) {
        return c.json({ error: preflight.message, totalCount: preflight.totalCount }, 400);
      }
    } catch (err) {
      log.warn({ err, artifactName: body.name }, 'Preflight check failed');
    }
  }

  // Fix #10: Enqueue with try-catch
  const job = await safeEnqueue(QUEUE_NAMES.MODULE_JOBS, 'registry.poll', {
    artifact: {
      id: crypto.randomUUID(),
      orgId,
      name: body.name,
      registry: 'npmjs',
      enabled: true,
      tagPatterns: body.tagPatterns,
      ignorePatterns: body.ignorePatterns,
      pollIntervalSeconds: body.pollIntervalSeconds,
      lastPolledAt: null,
      storedVersions: {},
      metadata: {},
    },
  });

  if (!job) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  return c.json(
    {
      data: {
        name: body.name,
        registry: 'npmjs',
        tagPatterns: body.tagPatterns,
        pollIntervalSeconds: body.pollIntervalSeconds,
        jobId: job.id,
      },
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET /modules/registry/packages/:id -- npm package detail
// ---------------------------------------------------------------------------

registryRouter.get('/packages/:id', async (c) => {
  return getArtifactDetail(c, 'npm_package');
});

// ---------------------------------------------------------------------------
// PUT /modules/registry/packages/:id -- update npm package config
// ---------------------------------------------------------------------------

registryRouter.put('/packages/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin' && role !== 'editor') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const id = c.req.param('id')!;
  const body = await c.req.json();
  const parsed = updateArtifactSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);

  const db = getDb();
  const [updated] = await db
    .update(rcArtifacts)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, 'npm_package'),
    ))
    .returning();

  if (!updated) return c.json({ error: 'Package not found' }, 404);
  const { credentialsEncrypted: _creds, ...safeUpdated } = updated;
  return c.json({ data: { ...safeUpdated, hasCredentials: !!_creds } });
});

// ---------------------------------------------------------------------------
// DELETE /modules/registry/packages/:id -- soft-delete npm package
// ---------------------------------------------------------------------------

registryRouter.delete('/packages/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const id = c.req.param('id')!;
  const db = getDb();
  const [updated] = await db
    .update(rcArtifacts)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, 'npm_package'),
    ))
    .returning({ id: rcArtifacts.id });

  if (!updated) return c.json({ error: 'Package not found' }, 404);
  return c.json({ status: 'ok', id: updated.id });
});

// ---------------------------------------------------------------------------
// POST /modules/registry/npm-orgs/import -- bulk import npm scope
// ---------------------------------------------------------------------------

const npmImportSchema = z.object({
  scope: z.string().min(2).regex(/^@[a-z0-9][-a-z0-9]*$/),
  tagPatterns: z.array(z.string()).default(['*']),
  pollIntervalSeconds: z.coerce.number().int().min(60).default(300),
});

registryRouter.post('/npm-orgs/import', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json();
  const parsed = npmImportSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);

  const packages = await searchNpmScope(parsed.data.scope);

  if (packages.length === 0) {
    return c.json({ data: { imported: 0, skipped: 0, packages: [] } });
  }

  const db = getDb();
  let imported = 0;
  let skipped = 0;
  const importedNames: string[] = [];

  for (const pkg of packages.slice(0, 100)) {
    try {
      await db
        .insert(rcArtifacts)
        .values({
          orgId,
          artifactType: 'npm_package',
          name: pkg.name,
          registry: 'npmjs',
          tagWatchPatterns: parsed.data.tagPatterns,
          tagIgnorePatterns: [],
          watchMode: 'dist-tags',
          enabled: true,
          pollIntervalSeconds: parsed.data.pollIntervalSeconds,
          metadata: { description: pkg.description, latestVersion: pkg.version },
        })
        .onConflictDoNothing();

      imported++;
      importedNames.push(pkg.name);
    } catch (err) {
      log.debug({ err, packageName: pkg.name }, 'Failed to import npm package');
      skipped++;
    }
  }

  return c.json({
    data: {
      imported,
      skipped,
      total: packages.length,
      packages: importedNames,
    },
  }, 201);
});

// ---------------------------------------------------------------------------
// Credential management schemas
// ---------------------------------------------------------------------------

const dockerCredentialsSchema = z.object({
  dockerUsername: z.string().min(1).optional(),
  dockerToken: z.string().min(1).optional(),
});

const npmCredentialsSchema = z.object({
  npmToken: z.string().min(1),
});

// ---------------------------------------------------------------------------
// POST /modules/registry/images/:id/credentials -- set Docker Hub credentials
// ---------------------------------------------------------------------------

registryRouter.post('/images/:id/credentials', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 401);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const id = c.req.param('id')!;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = dockerCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  const credentialsEncrypted = encrypt(JSON.stringify(parsed.data));

  const db = getDb();
  const [updated] = await db
    .update(rcArtifacts)
    .set({ credentialsEncrypted, updatedAt: new Date() })
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, 'docker_image'),
    ))
    .returning({ id: rcArtifacts.id });

  if (!updated) return c.json({ error: 'Image not found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /modules/registry/images/:id/credentials -- remove Docker Hub credentials
// ---------------------------------------------------------------------------

registryRouter.delete('/images/:id/credentials', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 401);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const id = c.req.param('id')!;
  const db = getDb();
  const [updated] = await db
    .update(rcArtifacts)
    .set({ credentialsEncrypted: null, updatedAt: new Date() })
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, 'docker_image'),
    ))
    .returning({ id: rcArtifacts.id });

  if (!updated) return c.json({ error: 'Image not found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /modules/registry/packages/:id/credentials -- set npm token
// ---------------------------------------------------------------------------

registryRouter.post('/packages/:id/credentials', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 401);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const id = c.req.param('id')!;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = npmCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.flatten() }, 400);
  }

  const credentialsEncrypted = encrypt(JSON.stringify(parsed.data));

  const db = getDb();
  const [updated] = await db
    .update(rcArtifacts)
    .set({ credentialsEncrypted, updatedAt: new Date() })
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, 'npm_package'),
    ))
    .returning({ id: rcArtifacts.id });

  if (!updated) return c.json({ error: 'Package not found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /modules/registry/packages/:id/credentials -- remove npm token
// ---------------------------------------------------------------------------

registryRouter.delete('/packages/:id/credentials', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 401);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const id = c.req.param('id')!;
  const db = getDb();
  const [updated] = await db
    .update(rcArtifacts)
    .set({ credentialsEncrypted: null, updatedAt: new Date() })
    .where(and(
      eq(rcArtifacts.id, id),
      eq(rcArtifacts.orgId, orgId),
      eq(rcArtifacts.artifactType, 'npm_package'),
    ))
    .returning({ id: rcArtifacts.id });

  if (!updated) return c.json({ error: 'Package not found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /modules/registry/event-types -- list event types this module handles
// ---------------------------------------------------------------------------

registryRouter.get('/event-types', async (c) => {
  const { eventTypes } = await import('./event-types.js');
  return c.json({ data: eventTypes });
});

// ---------------------------------------------------------------------------
// GET /modules/registry/overview — aggregated stats
// ---------------------------------------------------------------------------

registryRouter.get('/overview', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();

  const [imageRow] = await db
    .select({ total: count() })
    .from(rcArtifacts)
    .where(sql`${rcArtifacts.orgId} = ${orgId} AND ${rcArtifacts.artifactType} = 'docker_image'`);

  const [packageRow] = await db
    .select({ total: count() })
    .from(rcArtifacts)
    .where(sql`${rcArtifacts.orgId} = ${orgId} AND ${rcArtifacts.artifactType} = 'npm_package'`);

  const [detectionRow] = await db
    .select({ total: count() })
    .from(detections)
    .where(sql`${detections.orgId} = ${orgId} AND ${detections.moduleId} = 'registry' AND ${detections.status} = 'active'`);

  const [alertRow] = await db
    .select({ total: count() })
    .from(alerts)
    .where(sql`${alerts.orgId} = ${orgId} AND created_at > now() - interval '7 days'`);

  return c.json({
    stats: {
      trackedImages: imageRow?.total ?? 0,
      trackedPackages: packageRow?.total ?? 0,
      activeDetections: detectionRow?.total ?? 0,
      recentAlerts: alertRow?.total ?? 0,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /modules/registry/templates — detection templates
// ---------------------------------------------------------------------------

registryRouter.get('/templates', (c) => {
  const data = rcTemplates.map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    category: t.category,
    severity: t.severity,
    ruleCount: Array.isArray(t.rules) ? t.rules.length : 0,
    inputs: t.inputs ?? [],
  }));
  return c.json({ data });
});

// ---------------------------------------------------------------------------
// GET /modules/registry/webhook-config
// Returns webhook URLs and secret status for the authenticated org.
// ---------------------------------------------------------------------------

registryRouter.get('/webhook-config', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 401);

  // Derive origin from the incoming request URL (protocol + host)
  const reqUrl = new URL(c.req.url);
  const origin = process.env.API_URL ?? `${reqUrl.protocol}//${reqUrl.host}`;

  const webhookUrl = `${origin}/modules/registry/webhooks/docker`;
  const npmWebhookUrl = `${origin}/modules/registry/webhooks/npm`;

  const db = getDb();
  const [org] = await db
    .select({ webhookSecretEncrypted: organizations.webhookSecretEncrypted })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return c.json({ error: 'Organisation not found' }, 404);

  let hasSecret = false;
  let secretPrefix: string | null = null;

  if (org.webhookSecretEncrypted) {
    try {
      const plaintext = decrypt(org.webhookSecretEncrypted);
      hasSecret = true;
      secretPrefix = plaintext.slice(0, 8) + '...';
    } catch (err) {
      log.warn({ err, orgId }, 'Failed to decrypt webhook secret for status check');
    }
  }

  return c.json({ webhookUrl, npmWebhookUrl, hasSecret, secretPrefix });
});

// ---------------------------------------------------------------------------
// POST /modules/registry/webhook-config/rotate
// Generates a new webhook secret for the org (admin only).
// Returns the plaintext secret exactly once — never stored in plaintext.
// ---------------------------------------------------------------------------

registryRouter.post('/webhook-config/rotate', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');

  if (!orgId) return c.json({ error: 'Organisation required' }, 401);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const rawSecret = 'whsec_' + crypto.randomBytes(32).toString('hex');
  const encrypted = encrypt(rawSecret);

  const db = getDb();
  await db
    .update(organizations)
    .set({ webhookSecretEncrypted: encrypted })
    .where(eq(organizations.id, orgId));

  const secretPrefix = rawSecret.slice(0, 8) + '...';

  log.info({ orgId }, 'Webhook secret rotated');

  return c.json({ secret: rawSecret, secretPrefix });
});
