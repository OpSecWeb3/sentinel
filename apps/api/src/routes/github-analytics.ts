/**
 * GitHub module analytics routes — read-only GitHub intelligence for MCP tools.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { eq, and, gte, desc, sql, ilike } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { githubInstallations, githubRepositories } from '@sentinel/db/schema/github';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// GET /github/repo-activity — events for a specific repository
// ---------------------------------------------------------------------------

const repoActivitySchema = z.object({
  repoFullName: z.string().min(1),
  eventType: z.string().optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

router.get('/repo-activity', requireScope('api:read'), validate('query', repoActivitySchema), async (c) => {
  const query = getValidated<z.infer<typeof repoActivitySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const escaped = query.repoFullName.replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const conditions = [
    eq(events.orgId, orgId),
    eq(events.moduleId, 'github'),
    sql`${events.payload}->>'repository' ILIKE ${'%' + escaped + '%'}`,
  ];
  if (query.eventType) conditions.push(eq(events.eventType, query.eventType));
  if (query.since) conditions.push(gte(events.occurredAt, new Date(query.since)));

  const rows = await db.select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.occurredAt))
    .limit(query.limit);

  return c.json({ repoFullName: query.repoFullName, count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /github/actor-activity — all GitHub events attributed to an actor login
// ---------------------------------------------------------------------------

const actorActivitySchema = z.object({
  login: z.string().min(1),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

router.get('/actor-activity', requireScope('api:read'), validate('query', actorActivitySchema), async (c) => {
  const query = getValidated<z.infer<typeof actorActivitySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const escaped = query.login.replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const term = `%"login":"${escaped}"%`;

  const conditions = [
    eq(events.orgId, orgId),
    eq(events.moduleId, 'github'),
    sql`${events.payload}::text ILIKE ${term}`,
  ];
  if (query.since) conditions.push(gte(events.occurredAt, new Date(query.since)));

  const rows = await db.select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.occurredAt))
    .limit(query.limit);

  return c.json({ login: query.login, count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /github/installations — GitHub App installations for the org
// ---------------------------------------------------------------------------

router.get('/installations', requireScope('api:read'), async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const rows = await db.select({
    id: githubInstallations.id,
    installationId: githubInstallations.installationId,
    appSlug: githubInstallations.appSlug,
    targetType: githubInstallations.targetType,
    targetLogin: githubInstallations.targetLogin,
    permissions: githubInstallations.permissions,
    events: githubInstallations.events,
    status: githubInstallations.status,
    createdAt: githubInstallations.createdAt,
  })
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId))
    .limit(1000);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /github/repos — monitored repositories
// ---------------------------------------------------------------------------

const githubReposSchema = z.object({
  search: z.string().max(255).optional(),
});

router.get('/repos', requireScope('api:read'), validate('query', githubReposSchema), async (c) => {
  const query = getValidated<z.infer<typeof githubReposSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(githubRepositories.orgId, orgId)];
  if (query.search) {
    const term = `%${query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    conditions.push(ilike(githubRepositories.fullName, term));
  }

  const rows = await db.select({
    id: githubRepositories.id,
    fullName: githubRepositories.fullName,
    visibility: githubRepositories.visibility,
    defaultBranch: githubRepositories.defaultBranch,
    archived: githubRepositories.archived,
    fork: githubRepositories.fork,
    status: githubRepositories.status,
    lastSyncedAt: githubRepositories.lastSyncedAt,
  })
    .from(githubRepositories)
    .where(and(...conditions))
    .orderBy(githubRepositories.fullName)
    .limit(1000);

  return c.json({ data: rows });
});

export { router as githubAnalyticsRouter };
