/**
 * Registry module analytics routes — read-only artifact intelligence for MCP tools.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { eq, and, gte, desc, sql, isNull, or, count } from '@sentinel/db';
import {
  rcArtifacts, rcArtifactVersions, rcArtifactEvents,
  rcAttributions, rcCiNotifications,
} from '@sentinel/db/schema/registry';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// GET /registry/artifacts/summary — artifact list with tag count + last push date
// ---------------------------------------------------------------------------

router.get('/artifacts/summary', requireScope('api:read'), async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const rows = await db
    .select({
      id: rcArtifacts.id,
      artifactType: rcArtifacts.artifactType,
      name: rcArtifacts.name,
      registry: rcArtifacts.registry,
      enabled: rcArtifacts.enabled,
      lastPolledAt: rcArtifacts.lastPolledAt,
      tagCount: sql<number>`(SELECT COUNT(*) FROM rc_artifact_versions WHERE rc_artifact_versions.artifact_id = ${rcArtifacts.id} AND status = 'active')`.as('tag_count'),
      lastPushedAt: sql<Date | null>`(SELECT MAX(created_at) FROM rc_artifact_events WHERE rc_artifact_events.artifact_id = ${rcArtifacts.id})`.as('last_pushed_at'),
    })
    .from(rcArtifacts)
    .where(eq(rcArtifacts.orgId, orgId))
    .orderBy(rcArtifacts.name)
    .limit(1000);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /registry/digest-history — digest change log for an artifact
// ---------------------------------------------------------------------------

const digestHistorySchema = z.object({
  artifactName: z.string().min(1),
  tag: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

router.get('/digest-history', requireScope('api:read'), validate('query', digestHistorySchema), async (c) => {
  const query = getValidated<z.infer<typeof digestHistorySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const [artifact] = await db.select({ id: rcArtifacts.id })
    .from(rcArtifacts)
    .where(and(eq(rcArtifacts.orgId, orgId), eq(rcArtifacts.name, query.artifactName)))
    .limit(1);
  if (!artifact) return c.json({ error: 'Artifact not found' }, 404);

  const conditions = [
    eq(rcArtifactEvents.artifactId, artifact.id),
    sql`${rcArtifactEvents.artifactEventType} IN ('digest_change', 'new_tag', 'tag_removed')`,
  ];
  if (query.tag) conditions.push(eq(rcArtifactEvents.version, query.tag));

  const rows = await db.select()
    .from(rcArtifactEvents)
    .where(and(...conditions))
    .orderBy(desc(rcArtifactEvents.createdAt))
    .limit(query.limit);

  return c.json({ artifactName: query.artifactName, count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /registry/attribution-report — attribution status for an artifact's events
// ---------------------------------------------------------------------------

const attributionReportSchema = z.object({
  artifactName: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

router.get('/attribution-report', requireScope('api:read'), validate('query', attributionReportSchema), async (c) => {
  const query = getValidated<z.infer<typeof attributionReportSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(rcArtifacts.orgId, orgId)];
  if (query.artifactName) conditions.push(eq(rcArtifacts.name, query.artifactName));

  const rows = await db
    .select({
      attribution: rcAttributions,
      artifactName: rcArtifacts.name,
      artifactType: rcArtifacts.artifactType,
    })
    .from(rcAttributions)
    .innerJoin(rcArtifacts, eq(rcArtifacts.id, rcAttributions.artifactId))
    .where(and(...conditions))
    .orderBy(desc(rcAttributions.createdAt))
    .limit(query.limit);

  // Summary breakdown
  const summary = await db
    .select({ status: rcAttributions.status, count: count() })
    .from(rcAttributions)
    .innerJoin(rcArtifacts, eq(rcArtifacts.id, rcAttributions.artifactId))
    .where(and(...conditions))
    .groupBy(rcAttributions.status);

  return c.json({ summary: Object.fromEntries(summary.map(r => [r.status, r.count])), data: rows });
});

// ---------------------------------------------------------------------------
// GET /registry/unsigned-releases — artifact versions lacking cosign/SLSA
// ---------------------------------------------------------------------------

const unsignedReleasesSchema = z.object({
  artifactName: z.string().optional(),
});

router.get('/unsigned-releases', requireScope('api:read'), validate('query', unsignedReleasesSchema), async (c) => {
  const query = getValidated<z.infer<typeof unsignedReleasesSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [
    eq(rcArtifacts.orgId, orgId),
    eq(rcArtifactVersions.status, 'active'),
    or(
      sql`${rcArtifactVersions.verification}->>'hasSignature' = 'false'`,
      isNull(rcArtifactVersions.verification),
    )!,
  ];
  if (query.artifactName) conditions.push(eq(rcArtifacts.name, query.artifactName));

  const rows = await db
    .select({
      version: rcArtifactVersions,
      artifactName: rcArtifacts.name,
      artifactType: rcArtifacts.artifactType,
      registry: rcArtifacts.registry,
    })
    .from(rcArtifactVersions)
    .innerJoin(rcArtifacts, eq(rcArtifacts.id, rcArtifactVersions.artifactId))
    .where(and(...conditions))
    .orderBy(desc(rcArtifactVersions.createdAt))
    .limit(1000);

  return c.json({ count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /registry/ci-notifications — recent CI pipeline push records
// ---------------------------------------------------------------------------

const ciNotificationsSchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

router.get('/ci-notifications', requireScope('api:read'), validate('query', ciNotificationsSchema), async (c) => {
  const query = getValidated<z.infer<typeof ciNotificationsSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(rcCiNotifications.orgId, orgId)];
  if (query.since) conditions.push(gte(rcCiNotifications.receivedAt, new Date(query.since)));

  const rows = await db.select()
    .from(rcCiNotifications)
    .where(and(...conditions))
    .orderBy(desc(rcCiNotifications.receivedAt))
    .limit(query.limit);

  return c.json({ count: rows.length, data: rows });
});

export { router as registryAnalyticsRouter };
