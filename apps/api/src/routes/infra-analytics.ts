/**
 * Infra analytics routes — read-only queries for MCP intelligence tools.
 * All queries scope to orgId via infra_hosts.org_id.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { eq, and, gte, lte, sql, desc } from '@sentinel/db';
import {
  infraHosts, infraSnapshots, infraCdnOriginRecords, infraDnsRecords,
  infraDnsChanges, infraCertificates, infraTlsAnalyses, infraWhoisRecords,
  infraScoreHistory,
} from '@sentinel/db/schema/infra';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireAuth, requireOrg } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { validate, getValidated } from '../middleware/validate.js';

const router = new Hono<AppEnv>();
router.use('*', requireAuth, requireOrg);

// ---------------------------------------------------------------------------
// GET /infra/hosts — list monitored hosts
// ---------------------------------------------------------------------------

const listHostsSchema = z.object({
  search: z.string().max(255).optional(),
  isRoot: z.enum(['true', 'false']).optional(),
});

router.get('/hosts', requireScope('api:read'), validate('query', listHostsSchema), async (c) => {
  const query = getValidated<z.infer<typeof listHostsSchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const conditions = [eq(infraHosts.orgId, orgId)];
  if (query.search) conditions.push(sql`${infraHosts.hostname} ILIKE ${'%' + query.search.replace(/[%_\\]/g, (ch) => `\\${ch}`) + '%'}`);
  if (query.isRoot !== undefined) conditions.push(eq(infraHosts.isRoot, query.isRoot === 'true'));

  const rows = await db
    .select()
    .from(infraHosts)
    .where(and(...conditions))
    .orderBy(infraHosts.hostname)
    .limit(1000);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /infra/hosts/:hostname — full host intelligence
// ---------------------------------------------------------------------------

router.get('/hosts/:hostname', requireScope('api:read'), async (c) => {
  const hostname = c.req.param('hostname')!;
  const orgId = c.get('orgId');
  const db = getDb();

  const [host] = await db
    .select()
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.hostname, hostname)))
    .limit(1);

  if (!host) return c.json({ error: 'Host not found' }, 404);

  const [snapshot, cdnOrigins, dnsRecords] = await Promise.all([
    db.select().from(infraSnapshots)
      .where(eq(infraSnapshots.hostId, host.id))
      .orderBy(desc(infraSnapshots.scannedAt))
      .limit(1),
    db.select().from(infraCdnOriginRecords)
      .where(eq(infraCdnOriginRecords.hostId, host.id))
      .orderBy(desc(infraCdnOriginRecords.observedAt))
      .limit(1000),
    db.select().from(infraDnsRecords)
      .where(eq(infraDnsRecords.hostId, host.id))
      .orderBy(infraDnsRecords.recordType)
      .limit(1000),
  ]);

  return c.json({ data: { host, snapshot: snapshot[0] ?? null, cdnOrigins, dnsRecords } });
});

// ---------------------------------------------------------------------------
// GET /infra/hosts/:hostname/origin — CDN origin records
// ---------------------------------------------------------------------------

router.get('/hosts/:hostname/origin', requireScope('api:read'), async (c) => {
  const hostname = c.req.param('hostname')!;
  const orgId = c.get('orgId');
  const db = getDb();

  const [host] = await db.select({ id: infraHosts.id })
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.hostname, hostname)))
    .limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  const rows = await db.select().from(infraCdnOriginRecords)
    .where(eq(infraCdnOriginRecords.hostId, host.id))
    .orderBy(desc(infraCdnOriginRecords.observedAt))
    .limit(1000);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /infra/hosts/:hostname/dns-history — DNS change log
// ---------------------------------------------------------------------------

const dnsHistorySchema = z.object({
  since: z.string().datetime().optional(),
});

router.get('/hosts/:hostname/dns-history', requireScope('api:read'), validate('query', dnsHistorySchema), async (c) => {
  const hostname = c.req.param('hostname')!;
  const query = getValidated<z.infer<typeof dnsHistorySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const [host] = await db.select({ id: infraHosts.id })
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.hostname, hostname)))
    .limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  const conditions = [eq(infraDnsChanges.hostId, host.id)];
  if (query.since) conditions.push(gte(infraDnsChanges.detectedAt, new Date(query.since)));

  const rows = await db.select().from(infraDnsChanges)
    .where(and(...conditions))
    .orderBy(desc(infraDnsChanges.detectedAt))
    .limit(1000);

  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// GET /infra/cert-expiry — certs expiring within N days
// ---------------------------------------------------------------------------

const certExpirySchema = z.object({
  daysAhead: z.coerce.number().int().positive().default(30),
});

router.get('/cert-expiry', requireScope('api:read'), validate('query', certExpirySchema), async (c) => {
  const query = getValidated<z.infer<typeof certExpirySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const cutoff = new Date(Date.now() + query.daysAhead * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      cert: infraCertificates,
      hostname: infraHosts.hostname,
    })
    .from(infraCertificates)
    .innerJoin(infraHosts, eq(infraHosts.id, infraCertificates.hostId))
    .where(and(
      eq(infraHosts.orgId, orgId),
      lte(infraCertificates.notAfter, cutoff),
    ))
    .orderBy(infraCertificates.notAfter)
    .limit(1000);

  return c.json({ daysAhead: query.daysAhead, count: rows.length, data: rows });
});

// ---------------------------------------------------------------------------
// GET /infra/hosts/:hostname/tls — latest TLS analysis
// ---------------------------------------------------------------------------

router.get('/hosts/:hostname/tls', requireScope('api:read'), async (c) => {
  const hostname = c.req.param('hostname')!;
  const orgId = c.get('orgId');
  const db = getDb();

  const [host] = await db.select({ id: infraHosts.id })
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.hostname, hostname)))
    .limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  const [row] = await db.select().from(infraTlsAnalyses)
    .where(eq(infraTlsAnalyses.hostId, host.id))
    .orderBy(desc(infraTlsAnalyses.checkedAt))
    .limit(1);

  return c.json({ data: row ?? null });
});

// ---------------------------------------------------------------------------
// GET /infra/hosts/:hostname/whois — latest WHOIS record
// ---------------------------------------------------------------------------

router.get('/hosts/:hostname/whois', requireScope('api:read'), async (c) => {
  const hostname = c.req.param('hostname')!;
  const orgId = c.get('orgId');
  const db = getDb();

  const [host] = await db.select({ id: infraHosts.id })
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.hostname, hostname)))
    .limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  const [row] = await db.select().from(infraWhoisRecords)
    .where(eq(infraWhoisRecords.hostId, host.id))
    .orderBy(desc(infraWhoisRecords.checkedAt))
    .limit(1);

  return c.json({ data: row ?? null });
});

// ---------------------------------------------------------------------------
// GET /infra/hosts/:hostname/score — security score history
// ---------------------------------------------------------------------------

const scoreHistorySchema = z.object({
  limit: z.coerce.number().int().positive().max(90).default(30),
});

router.get('/hosts/:hostname/score', requireScope('api:read'), validate('query', scoreHistorySchema), async (c) => {
  const hostname = c.req.param('hostname')!;
  const query = getValidated<z.infer<typeof scoreHistorySchema>>(c, 'query');
  const orgId = c.get('orgId');
  const db = getDb();

  const [host] = await db.select({ id: infraHosts.id, currentScore: infraHosts.currentScore })
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.hostname, hostname)))
    .limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  const history = await db.select().from(infraScoreHistory)
    .where(eq(infraScoreHistory.hostId, host.id))
    .orderBy(desc(infraScoreHistory.recordedAt))
    .limit(query.limit);

  return c.json({ currentScore: host.currentScore, data: history });
});

export { router as infraAnalyticsRouter };
