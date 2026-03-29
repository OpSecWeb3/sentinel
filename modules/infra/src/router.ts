/**
 * Infrastructure module Hono router.
 * Manages monitored hosts, scan triggering, and result retrieval.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import {
  infraHosts,
  infraScanEvents,
  infraScoreHistory,
  infraCertificates,
  infraDnsRecords,
  infraDnsChanges,
  infraDnsHealthChecks,
  infraScanSchedules,
  infraCtLogEntries,
  infraWhoisChanges,
  infraTlsAnalyses,
  infraHttpHeaderChecks,
  infraSnapshots,
  infraWhoisRecords,
  infraFindingSuppressions,
  infraCdnProviderConfigs,
  infraCdnOriginRecords,
} from '@sentinel/db/schema/infra';
import { eq, and, desc, asc, lte, gte, sql, inArray, ilike, count } from '@sentinel/db';
import { alerts, detections } from '@sentinel/db/schema/core';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';
import type { AppEnv } from '@sentinel/shared/hono-types';

const log = rootLogger.child({ component: 'infra-router' });

export const infraRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** RFC 1123 hostname + basic wildcard. Rejects IPs and garbage input. */
const HOSTNAME_RE = /^(?!\-)([a-zA-Z0-9\-]{1,63}\.)+[a-zA-Z]{2,}$/;

function isValidHostname(value: string): boolean {
  return HOSTNAME_RE.test(value) && value.length <= 253;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreToGrade(score: number | null): string | null {
  if (score === null) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

// ---------------------------------------------------------------------------
// GET /modules/infra/hosts — paginated list of monitored hosts
// ---------------------------------------------------------------------------

infraRouter.get('/hosts', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));
  const offset = (page - 1) * limit;
  const sortField = c.req.query('sort') ?? 'hostname';
  const sortDir = c.req.query('dir') ?? 'asc';
  const q = c.req.query('q')?.toLowerCase() ?? '';
  const showAll = c.req.query('all') === 'true';

  const db = getDb();

  // --- Shared helpers ---------------------------------------------------

  function computeStatus(h: { isActive: boolean; lastScannedAt: Date | null }): string {
    if (!h.isActive) return 'removed';
    if (!h.lastScannedAt) return 'pending';
    const hoursSinceScan = (Date.now() - h.lastScannedAt.getTime()) / 3_600_000;
    if (hoursSinceScan > 48) return 'error';
    return 'active';
  }

  type HostRow = {
    id: string; hostname: string; isRoot: boolean; parentId: string | null;
    score: number | null; grade: string | null; lastScanAt: string | null;
    certExpiry: string | null; status: string; createdAt: string;
  };

  /** Build base WHERE conditions common to both paths. */
  const baseConditions = [
    eq(infraHosts.orgId, orgId),
    eq(infraHosts.isActive, true),
    ...(showAll ? [] : [eq(infraHosts.isRoot, true)]),
    ...(q ? [ilike(infraHosts.hostname, `%${q}%`)] : []),
  ];

  /** Fetch cert expiry (latest notAfter) for a set of host IDs. */
  async function fetchCertMap(hostIds: string[]): Promise<Map<string, Date>> {
    if (hostIds.length === 0) return new Map();
    const certRows = await db
      .select({ hostId: infraCertificates.hostId, notAfter: infraCertificates.notAfter })
      .from(infraCertificates)
      .where(inArray(infraCertificates.hostId, hostIds));
    const m = new Map<string, Date>();
    for (const row of certRows) {
      const existing = m.get(row.hostId);
      if (!existing || (row.notAfter && row.notAfter > existing)) {
        if (row.notAfter) m.set(row.hostId, row.notAfter);
      }
    }
    return m;
  }

  /** Map a raw DB row + certMap entry to the API response shape. */
  function toHostRow(h: typeof hostSelect, certMap: Map<string, Date>): HostRow {
    return {
      id: h.id,
      hostname: h.hostname,
      isRoot: h.isRoot,
      parentId: h.parentId ?? null,
      score: h.currentScore ?? null,
      grade: scoreToGrade(h.currentScore),
      lastScanAt: h.lastScannedAt?.toISOString() ?? null,
      certExpiry: certMap.get(h.id)?.toISOString() ?? null,
      status: computeStatus(h),
      createdAt: h.createdAt.toISOString(),
    };
  }

  // Dummy type for the select shape
  type HostSelect = {
    id: string; hostname: string; currentScore: number | null;
    lastScannedAt: Date | null; isActive: boolean; isRoot: boolean;
    parentId: string | null; createdAt: Date;
  };
  const hostSelect = {} as HostSelect; // used only for typeof

  // --- Non-tree path: SQL pagination (the common case) -----------------

  if (!showAll) {
    // Determine SQL ORDER BY based on sortField
    const orderCol =
      sortField === 'score' ? infraHosts.currentScore :
      sortField === 'lastScanAt' ? infraHosts.lastScannedAt :
      sortField === 'certExpiry' ? infraHosts.lastScannedAt : // certExpiry sort falls back to lastScannedAt at SQL level
      infraHosts.hostname;

    // Nulls-last ordering: use SQL NULLS LAST for consistent behavior
    const orderExpr = sortDir === 'desc'
      ? sql`${orderCol} DESC NULLS LAST`
      : sql`${orderCol} ASC NULLS LAST`;

    // Fetch count and page in parallel
    const [countResult, pageHosts] = await Promise.all([
      db.select({ total: count() })
        .from(infraHosts)
        .where(and(...baseConditions)),
      db.select({
          id: infraHosts.id,
          hostname: infraHosts.hostname,
          currentScore: infraHosts.currentScore,
          lastScannedAt: infraHosts.lastScannedAt,
          isActive: infraHosts.isActive,
          isRoot: infraHosts.isRoot,
          parentId: infraHosts.parentId,
          createdAt: infraHosts.createdAt,
        })
        .from(infraHosts)
        .where(and(...baseConditions))
        .orderBy(orderExpr)
        .limit(limit)
        .offset(offset),
    ]);

    const total = Number(countResult[0]?.total ?? 0);
    const certMap = await fetchCertMap(pageHosts.map((h) => h.id));
    const data = pageHosts.map((h) => toHostRow(h, certMap));

    return c.json({
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }

  // --- Tree path (showAll=true): parent-child interleaving -------------
  // Tree interleaving requires knowing the full ordered set to group
  // children under parents, so we keep in-memory ordering here. The search
  // filter is still pushed to SQL to reduce the result set.

  const allHosts = await db
    .select({
      id: infraHosts.id,
      hostname: infraHosts.hostname,
      currentScore: infraHosts.currentScore,
      lastScannedAt: infraHosts.lastScannedAt,
      isActive: infraHosts.isActive,
      isRoot: infraHosts.isRoot,
      parentId: infraHosts.parentId,
      createdAt: infraHosts.createdAt,
    })
    .from(infraHosts)
    .where(and(...baseConditions));

  const certMap = await fetchCertMap(allHosts.map((h) => h.id));
  const mapped = allHosts.map((h) => toHostRow(h, certMap));

  function sortCmp(a: HostRow, b: HostRow): number {
    let av: string | number | null, bv: string | number | null;
    if (sortField === 'score') { av = a.score; bv = b.score; }
    else if (sortField === 'lastScanAt') { av = a.lastScanAt; bv = b.lastScanAt; }
    else if (sortField === 'certExpiry') { av = a.certExpiry; bv = b.certExpiry; }
    else { av = a.hostname; bv = b.hostname; }
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'desc' ? -cmp : cmp;
  }

  // Group: sort roots, then interleave children after their parent
  const roots = mapped.filter((h) => h.isRoot).sort(sortCmp);
  const childrenByParent = new Map<string, HostRow[]>();
  for (const h of mapped) {
    if (!h.isRoot && h.parentId) {
      const arr = childrenByParent.get(h.parentId) ?? [];
      arr.push(h);
      childrenByParent.set(h.parentId, arr);
    }
  }
  for (const arr of childrenByParent.values()) arr.sort((a, b) => a.hostname.localeCompare(b.hostname));
  const hosts: HostRow[] = [];
  for (const root of roots) {
    hosts.push(root);
    const children = childrenByParent.get(root.id) ?? [];
    hosts.push(...children);
  }
  // Orphaned children (parent not in result set due to search filter) appended at end
  for (const h of mapped) {
    if (!h.isRoot && (!h.parentId || !mapped.find((r) => r.id === h.parentId))) {
      hosts.push(h);
    }
  }

  const total = hosts.length;

  return c.json({
    data: hosts.slice(offset, offset + limit),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// ---------------------------------------------------------------------------
// POST /modules/infra/hosts — add a host to monitor
// ---------------------------------------------------------------------------

const addHostSchema = z.object({
  hostname: z.string().min(1).max(253).transform((v) => v.trim().toLowerCase()),
  scanIntervalMinutes: z.number().int().min(5).default(1440),
  probeEnabled: z.boolean().default(false),
  probeIntervalMinutes: z.number().int().min(1).default(5),
});

infraRouter.post('/hosts', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Insufficient permissions' }, 403);

  const body = addHostSchema.parse(await c.req.json());

  if (!isValidHostname(body.hostname)) {
    return c.json({ error: 'Invalid hostname. Must be a valid domain name.' }, 400);
  }

  const db = getDb();

  // Upsert: re-activate if previously removed
  const [host] = await db
    .insert(infraHosts)
    .values({
      orgId,
      hostname: body.hostname,
      isRoot: true,
      isActive: true,
      source: 'manual',
    })
    .onConflictDoUpdate({
      target: [infraHosts.orgId, infraHosts.hostname],
      set: { isActive: true },
    })
    .returning();

  // Create or update scan schedule
  await db
    .insert(infraScanSchedules)
    .values({
      hostId: host.id,
      enabled: true,
      intervalMinutes: body.scanIntervalMinutes,
      probeEnabled: body.probeEnabled,
      probeIntervalMinutes: body.probeIntervalMinutes,
      nextRunAt: new Date(), // schedule first scan immediately
      probeNextRunAt: body.probeEnabled ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: infraScanSchedules.hostId,
      set: {
        enabled: true,
        intervalMinutes: body.scanIntervalMinutes,
        probeEnabled: body.probeEnabled,
        probeIntervalMinutes: body.probeIntervalMinutes,
        nextRunAt: new Date(),
        probeNextRunAt: body.probeEnabled ? new Date() : null,
      },
    });

  // Enqueue an initial full scan
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  await queue.add('infra.scan', {
    hostId: host.id,
    orgId,
    hostname: body.hostname,
    priority: 'interactive',
  });

  return c.json({ data: { id: host.id, hostname: host.hostname } }, 201);
});

// ---------------------------------------------------------------------------
// GET /modules/infra/hosts/:id — enriched host detail
// ---------------------------------------------------------------------------

infraRouter.get('/hosts/:id', async (c) => {
  const orgId = c.get('orgId');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const [host] = await db.select().from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId))).limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  const [
    latestCert, latestTls, latestHeaders, latestInfra, latestWhois, latestDnsHealth,
    dnsRecords, dnsChanges, latestScore, scoreHistory, recentScans, schedule, suppressions,
  ] = await Promise.all([
    db.select().from(infraCertificates).where(eq(infraCertificates.hostId, hostId))
      .orderBy(desc(infraCertificates.observedAt)).limit(1).then((r) => r[0] ?? null),
    db.select().from(infraTlsAnalyses).where(eq(infraTlsAnalyses.hostId, hostId))
      .orderBy(desc(infraTlsAnalyses.checkedAt)).limit(1).then((r) => r[0] ?? null),
    db.select().from(infraHttpHeaderChecks).where(eq(infraHttpHeaderChecks.hostId, hostId))
      .orderBy(desc(infraHttpHeaderChecks.checkedAt)).limit(1).then((r) => r[0] ?? null),
    db.select().from(infraSnapshots).where(eq(infraSnapshots.hostId, hostId))
      .orderBy(desc(infraSnapshots.scannedAt)).limit(1).then((r) => r[0] ?? null),
    db.select().from(infraWhoisRecords).where(eq(infraWhoisRecords.hostId, hostId))
      .orderBy(desc(infraWhoisRecords.checkedAt)).limit(1).then((r) => r[0] ?? null),
    db.select().from(infraDnsHealthChecks).where(eq(infraDnsHealthChecks.hostId, hostId))
      .orderBy(desc(infraDnsHealthChecks.checkedAt)).limit(1).then((r) => r[0] ?? null),
    db.select().from(infraDnsRecords).where(eq(infraDnsRecords.hostId, hostId))
      .orderBy(infraDnsRecords.recordType),
    db.select().from(infraDnsChanges).where(eq(infraDnsChanges.hostId, hostId))
      .orderBy(desc(infraDnsChanges.detectedAt)).limit(50),
    db.select().from(infraScoreHistory).where(eq(infraScoreHistory.hostId, hostId))
      .orderBy(desc(infraScoreHistory.recordedAt)).limit(1).then((r) => r[0] ?? null),
    db.select({ recordedAt: infraScoreHistory.recordedAt, score: infraScoreHistory.score, grade: infraScoreHistory.grade })
      .from(infraScoreHistory).where(eq(infraScoreHistory.hostId, hostId))
      .orderBy(desc(infraScoreHistory.recordedAt)).limit(90),
    db.select().from(infraScanEvents).where(eq(infraScanEvents.hostId, hostId))
      .orderBy(desc(infraScanEvents.startedAt)).limit(5),
    db.select().from(infraScanSchedules).where(eq(infraScanSchedules.hostId, hostId))
      .limit(1).then((r) => r[0] ?? null),
    db.select().from(infraFindingSuppressions).where(eq(infraFindingSuppressions.hostId, hostId)),
  ]);

  const suppressionSet = new Set(suppressions.map((s) => `${s.category}:${s.issue}`));

  let scoreDeductions: Array<{ category: string; item: string; points: number; description: string; suppressed: boolean }> = [];
  if (latestScore?.deductions) {
    const raw = latestScore.deductions as Array<{ category: string; issue: string; points: number; evidence?: string }>;
    scoreDeductions = raw.map((d) => ({
      category: d.category,
      item: d.issue,
      points: d.points,
      description: d.evidence ?? '',
      suppressed: suppressionSet.has(`${d.category}:${d.issue}`),
    }));
  }

  const httpHeaders = latestHeaders ? [
    { name: 'Strict-Transport-Security', present: latestHeaders.hstsPresent, value: latestHeaders.hstsMaxAge ? `max-age=${latestHeaders.hstsMaxAge}` : null, expected: true },
    { name: 'Content-Security-Policy', present: latestHeaders.cspPresent, value: latestHeaders.cspHeader, expected: true },
    { name: 'X-Frame-Options', present: latestHeaders.xFrameOptions !== null, value: latestHeaders.xFrameOptions, expected: true },
    { name: 'X-Content-Type-Options', present: latestHeaders.xContentTypeOptions, value: latestHeaders.xContentTypeOptions ? 'nosniff' : null, expected: true },
    { name: 'Referrer-Policy', present: latestHeaders.referrerPolicy !== null, value: latestHeaders.referrerPolicy, expected: false },
    { name: 'Permissions-Policy', present: latestHeaders.permissionsPolicyPresent, value: latestHeaders.permissionsPolicyHeader, expected: false },
    { name: 'Server', present: latestHeaders.serverHeaderPresent, value: latestHeaders.serverHeaderValue, expected: false },
  ] : [];

  function computeStatus(): string {
    if (!host.isActive) return 'removed';
    if (!host.lastScannedAt) return 'pending';
    return (Date.now() - host.lastScannedAt.getTime()) / 3_600_000 > 48 ? 'error' : 'active';
  }

  return c.json({
    data: {
      id: host.id, hostname: host.hostname,
      score: host.currentScore ?? null, grade: scoreToGrade(host.currentScore),
      lastScanAt: host.lastScannedAt?.toISOString() ?? null, status: computeStatus(),
      createdAt: host.createdAt.toISOString(),
      certificate: latestCert ? {
        subject: latestCert.subject, issuer: latestCert.issuer,
        expiresAt: latestCert.notAfter.toISOString(), issuedAt: latestCert.notBefore.toISOString(),
        sans: latestCert.sanList as string[], chainValid: latestCert.chainValid,
        chainError: latestCert.chainValid ? null : 'Chain validation failed',
        serialNumber: latestCert.serialNumber, signatureAlgorithm: null,
      } : null,
      tls: latestTls ? {
        supportedVersions: latestTls.tlsVersions as string[],
        cipherSuite: null, keyExchange: latestTls.keyExchange,
        protocolVersion: latestTls.hasTls13 ? 'TLS 1.3' : latestTls.hasTls12 ? 'TLS 1.2' : null,
        hasWeakCiphers: latestTls.hasWeakCiphers, weakCiphers: latestTls.weakCipherList as string[],
      } : null,
      dnsRecords: dnsRecords.map((r) => ({ type: r.recordType, value: r.recordValue, ttl: r.ttl ?? 0 })),
      dnsChanges: dnsChanges.map((ch) => ({
        id: ch.id, recordType: ch.recordType, oldValue: ch.oldValue ?? '',
        newValue: ch.newValue ?? '', severity: ch.severity ?? 'info',
        detectedAt: ch.detectedAt.toISOString(),
      })),
      httpHeaders,
      infra: latestInfra ? {
        ip: latestInfra.ipAddress,
        geo: latestInfra.geoCountry ? { country: latestInfra.geoCountry, city: latestInfra.geoCity ?? '', region: '' } : null,
        cloudProvider: latestInfra.cloudProvider, asn: latestInfra.asn, asnOrg: latestInfra.asnOrg,
        openPorts: (latestInfra.openPorts as Array<{ port: number }>).map((p) => p.port),
      } : null,
      whois: latestWhois ? {
        registrar: latestWhois.registrar,
        createdDate: latestWhois.registrationDate?.toISOString() ?? null,
        expiresDate: latestWhois.expiryDate?.toISOString() ?? null,
        updatedDate: latestWhois.updatedDate?.toISOString() ?? null,
        nameServers: latestWhois.nameServers as string[], registrant: null,
      } : null,
      scoreDeductions,
      dnsHealth: latestDnsHealth ? {
        dnssecEnabled: latestDnsHealth.dnssecEnabled,
        dmarcRecord: latestDnsHealth.dmarcRecord,
        dmarcPolicy: latestDnsHealth.dmarcPolicy,
        spfRecord: latestDnsHealth.spfRecord,
        spfValid: latestDnsHealth.spfValid,
        caaRecords: latestDnsHealth.caaRecords as string[],
        danglingCnames: latestDnsHealth.danglingCnames as string[],
        checkedAt: latestDnsHealth.checkedAt.toISOString(),
      } : null,
      scoreHistory: scoreHistory.map((s) => ({ date: s.recordedAt.toISOString(), score: s.score, grade: s.grade ?? scoreToGrade(s.score) })),
      recentScans: recentScans.map((s) => ({ id: s.id, status: s.status, startedAt: s.startedAt.toISOString(), completedAt: s.completedAt?.toISOString() ?? null, steps: [] })),
      schedule: schedule ? { enabled: schedule.enabled, scanIntervalHours: Math.round(schedule.intervalMinutes / 60), probeEnabled: schedule.probeEnabled, probeIntervalMinutes: schedule.probeIntervalMinutes, nextRunAt: schedule.nextRunAt?.toISOString() ?? null, probeNextRunAt: schedule.probeNextRunAt?.toISOString() ?? null } : null,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /modules/infra/hosts/:id/scan — trigger a manual scan
// ---------------------------------------------------------------------------

infraRouter.post('/hosts/:id/scan', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Insufficient permissions' }, 403);

  const db = getDb();
  const [host] = await db
    .select({ id: infraHosts.id, hostname: infraHosts.hostname })
    .from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId)))
    .limit(1);

  if (!host) return c.json({ error: 'Host not found' }, 404);

  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  const job = await queue.add(
    'infra.scan',
    {
      hostId: host.id,
      orgId,
      hostname: host.hostname,
      priority: 'interactive',
    },
    { priority: 1 }, // higher BullMQ priority for interactive requests
  );

  return c.json({ data: { jobId: job.id, status: 'queued' } }, 202);
});

// ---------------------------------------------------------------------------
// DELETE /modules/infra/hosts/:id — remove a host (soft-delete)
// ---------------------------------------------------------------------------

infraRouter.delete('/hosts/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const db = getDb();

  const [result] = await db
    .update(infraHosts)
    .set({ isActive: false })
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId)))
    .returning({ id: infraHosts.id });

  if (!result) return c.json({ error: 'Host not found' }, 404);

  // Disable the schedule
  await db
    .update(infraScanSchedules)
    .set({ enabled: false, probeEnabled: false })
    .where(eq(infraScanSchedules.hostId, hostId));

  // If this was the last active host, pause all infra detections for the org
  const [remaining] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.isActive, true)));

  if ((remaining?.total ?? 0) === 0) {
    const paused = await db
      .update(detections)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(and(eq(detections.orgId, orgId), eq(detections.moduleId, 'infra'), eq(detections.status, 'active')))
      .returning({ id: detections.id });

    if (paused.length > 0) {
      log.warn({ orgId, pausedCount: paused.length }, 'Last active infra host removed — paused all infra detections');
    }
  }

  return c.json({ data: { id: result.id, status: 'removed' } });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/hosts/:id/history — score history over time
// ---------------------------------------------------------------------------

infraRouter.get('/hosts/:id/history', async (c) => {
  const orgId = c.get('orgId');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const limit = Math.min(Number(c.req.query('limit') ?? 90), 365);

  const db = getDb();

  // Verify host belongs to org
  const [host] = await db
    .select({ id: infraHosts.id })
    .from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId)))
    .limit(1);

  if (!host) return c.json({ error: 'Host not found' }, 404);

  const scores = await db
    .select({
      id: infraScoreHistory.id,
      score: infraScoreHistory.score,
      grade: infraScoreHistory.grade,
      breakdown: infraScoreHistory.breakdown,
      recordedAt: infraScoreHistory.recordedAt,
    })
    .from(infraScoreHistory)
    .where(eq(infraScoreHistory.hostId, hostId))
    .orderBy(desc(infraScoreHistory.recordedAt))
    .limit(limit);

  return c.json({ data: scores });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/hosts/:id/certificates — certificate history
// ---------------------------------------------------------------------------

infraRouter.get('/hosts/:id/certificates', async (c) => {
  const orgId = c.get('orgId');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);

  const db = getDb();

  const [host] = await db
    .select({ id: infraHosts.id })
    .from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId)))
    .limit(1);

  if (!host) return c.json({ error: 'Host not found' }, 404);

  const certs = await db
    .select()
    .from(infraCertificates)
    .where(eq(infraCertificates.hostId, hostId))
    .orderBy(desc(infraCertificates.observedAt))
    .limit(limit);

  return c.json({ data: certs });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/hosts/:id/dns — current DNS records + change history
// ---------------------------------------------------------------------------

infraRouter.get('/hosts/:id/dns', async (c) => {
  const orgId = c.get('orgId');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const changesLimit = Math.min(Number(c.req.query('changes_limit') ?? 50), 200);

  const db = getDb();

  const [host] = await db
    .select({ id: infraHosts.id })
    .from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId)))
    .limit(1);

  if (!host) return c.json({ error: 'Host not found' }, 404);

  const [records, changes] = await Promise.all([
    db
      .select()
      .from(infraDnsRecords)
      .where(eq(infraDnsRecords.hostId, hostId))
      .orderBy(infraDnsRecords.recordType),
    db
      .select()
      .from(infraDnsChanges)
      .where(eq(infraDnsChanges.hostId, hostId))
      .orderBy(desc(infraDnsChanges.detectedAt))
      .limit(changesLimit),
  ]);

  return c.json({ data: { records, changes } });
});

// ---------------------------------------------------------------------------
// POST /modules/infra/hosts/:id/suppressions — suppress/unsuppress findings
// ---------------------------------------------------------------------------

infraRouter.post('/hosts/:id/suppressions', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Insufficient permissions' }, 403);

  const body = z.object({
    category: z.string().min(1),
    item: z.string().min(1),
    action: z.enum(['suppress', 'unsuppress']),
  }).parse(await c.req.json());

  const db = getDb();
  const [host] = await db.select({ id: infraHosts.id }).from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId))).limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  if (body.action === 'suppress') {
    await db.insert(infraFindingSuppressions)
      .values({ hostId, category: body.category, issue: body.item, suppressedAt: new Date() })
      .onConflictDoNothing();
  } else {
    await db.delete(infraFindingSuppressions)
      .where(and(
        eq(infraFindingSuppressions.hostId, hostId),
        eq(infraFindingSuppressions.category, body.category),
        eq(infraFindingSuppressions.issue, body.item),
      ));
  }
  return c.json({ data: { suppressed: body.action === 'suppress' } });
});

// ---------------------------------------------------------------------------
// PUT /modules/infra/hosts/:id/schedule — update scan schedule
// ---------------------------------------------------------------------------

infraRouter.put('/hosts/:id/schedule', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Insufficient permissions' }, 403);

  const body = z.object({
    enabled: z.boolean().optional().default(true),
    scanIntervalHours: z.number().int().min(1).max(168).default(24),
    probeEnabled: z.boolean().optional().default(true),
    probeIntervalMinutes: z.number().int().min(1).max(60).default(5),
  }).parse(await c.req.json());

  const db = getDb();
  const [host] = await db.select({ id: infraHosts.id }).from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId))).limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  const now = new Date();
  await db.insert(infraScanSchedules)
    .values({
      hostId,
      enabled: body.enabled,
      intervalMinutes: body.scanIntervalHours * 60,
      probeEnabled: body.probeEnabled,
      probeIntervalMinutes: body.probeIntervalMinutes,
      nextRunAt: now,
      probeNextRunAt: body.probeEnabled ? now : null,
    })
    .onConflictDoUpdate({
      target: infraScanSchedules.hostId,
      set: {
        enabled: body.enabled,
        intervalMinutes: body.scanIntervalHours * 60,
        probeEnabled: body.probeEnabled,
        probeIntervalMinutes: body.probeIntervalMinutes,
        nextRunAt: now,
        probeNextRunAt: body.probeEnabled ? now : null,
      },
    });

  return c.json({ data: { enabled: body.enabled, scanIntervalHours: body.scanIntervalHours, probeEnabled: body.probeEnabled, probeIntervalMinutes: body.probeIntervalMinutes } });
});

// ---------------------------------------------------------------------------
// POST /modules/infra/hosts/:id/discover — subdomain discovery via crt.sh
// ---------------------------------------------------------------------------

/** Maximum subdomains to process from a single crt.sh discovery request. */
const MAX_DISCOVERY_RESULTS = 100;

infraRouter.post('/hosts/:id/discover', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin' && role !== 'editor') return c.json({ error: 'Insufficient permissions' }, 403);

  const db = getDb();
  const [host] = await db.select({ id: infraHosts.id, hostname: infraHosts.hostname }).from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId))).limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  let discovered: string[] = [];
  let totalUnique = 0;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const resp = await fetch(`https://crt.sh/?q=%.${host.hostname}&output=json`, {
      signal: controller.signal, headers: { 'User-Agent': 'sentinel-infra/1.0' },
    });
    clearTimeout(timeout);
    if (resp.ok) {
      const data = await resp.json() as Array<{ name_value: string }>;
      const names = new Set<string>();
      for (const entry of data) {
        for (const name of entry.name_value.split('\n')) {
          const trimmed = name.trim().toLowerCase().replace(/^\*\./, '');
          if (trimmed.endsWith(`.${host.hostname}`) && isValidHostname(trimmed)) names.add(trimmed);
        }
      }
      totalUnique = names.size;
      discovered = Array.from(names).slice(0, MAX_DISCOVERY_RESULTS);
    }
  } catch { /* crt.sh is best-effort */ }

  const truncated = totalUnique > MAX_DISCOVERY_RESULTS;

  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  let newCount = 0;
  for (const sub of discovered) {
    const [existing] = await db.select({ id: infraHosts.id }).from(infraHosts)
      .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.hostname, sub))).limit(1);
    if (!existing) {
      const [newHost] = await db.insert(infraHosts)
        .values({ orgId, hostname: sub, isRoot: false, parentId: hostId, source: 'crt_sh', isActive: true })
        .returning();
      await db.insert(infraScanSchedules).values({
        hostId: newHost.id, enabled: true, intervalMinutes: 1440,
        probeEnabled: false, probeIntervalMinutes: 5, nextRunAt: new Date(),
      });
      await queue.add('infra.scan', { hostId: newHost.id, orgId, hostname: sub, priority: 'scheduled' });
      newCount++;
    }
  }
  return c.json({
    data: {
      discovered: discovered.length,
      newHosts: newCount,
      totalFound: totalUnique,
      truncated,
      ...(truncated ? { message: `Results capped at ${MAX_DISCOVERY_RESULTS} of ${totalUnique} unique subdomains` } : {}),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/hosts/:id/subdomains — list child hosts of a root host
// ---------------------------------------------------------------------------

infraRouter.get('/hosts/:id/subdomains', async (c) => {
  const orgId = c.get('orgId');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const [host] = await db.select({ id: infraHosts.id }).from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId))).limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);

  const children = await db.select({
    id: infraHosts.id,
    hostname: infraHosts.hostname,
    currentScore: infraHosts.currentScore,
    lastScannedAt: infraHosts.lastScannedAt,
    isActive: infraHosts.isActive,
    source: infraHosts.source,
    createdAt: infraHosts.createdAt,
  })
  .from(infraHosts)
  .where(and(eq(infraHosts.parentId, hostId), eq(infraHosts.isActive, true)))
  .orderBy(asc(infraHosts.hostname));

  const childIds = children.map((ch) => ch.id);
  const certRows = childIds.length > 0
    ? await db.select({ hostId: infraCertificates.hostId, notAfter: infraCertificates.notAfter })
        .from(infraCertificates)
        .where(inArray(infraCertificates.hostId, childIds))
    : [];

  const certMap = new Map<string, Date>();
  for (const row of certRows) {
    const existing = certMap.get(row.hostId);
    if (!existing || (row.notAfter && row.notAfter > existing)) {
      if (row.notAfter) certMap.set(row.hostId, row.notAfter);
    }
  }

  function computeChildStatus(h: { isActive: boolean; lastScannedAt: Date | null }): string {
    if (!h.isActive) return 'removed';
    if (!h.lastScannedAt) return 'pending';
    return (Date.now() - h.lastScannedAt.getTime()) / 3_600_000 > 48 ? 'error' : 'active';
  }

  return c.json({
    data: children.map((ch) => ({
      id: ch.id,
      hostname: ch.hostname,
      score: ch.currentScore ?? null,
      grade: scoreToGrade(ch.currentScore),
      lastScanAt: ch.lastScannedAt?.toISOString() ?? null,
      certExpiry: certMap.get(ch.id)?.toISOString() ?? null,
      status: computeChildStatus(ch),
      source: ch.source,
      createdAt: ch.createdAt.toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/hosts/:id/cdn-origins — CDN origin records for a host
// ---------------------------------------------------------------------------

infraRouter.get('/hosts/:id/cdn-origins', async (c) => {
  const orgId = c.get('orgId');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  const db = getDb();
  const [host] = await db.select({ id: infraHosts.id }).from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId))).limit(1);
  if (!host) return c.json({ error: 'Host not found' }, 404);
  const origins = await db.select().from(infraCdnOriginRecords)
    .where(eq(infraCdnOriginRecords.hostId, hostId)).orderBy(infraCdnOriginRecords.provider);
  return c.json({ data: origins });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/overview — stats + recent alerts for the infra dashboard
// ---------------------------------------------------------------------------

infraRouter.get('/overview', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const dayAgo = new Date(Date.now() - 86_400_000);
  const thresholdDate = new Date(Date.now() + 30 * 86_400_000);

  const [hosts, recentAlerts] = await Promise.all([
    db.select({
      id: infraHosts.id,
      currentScore: infraHosts.currentScore,
      lastScannedAt: infraHosts.lastScannedAt,
    })
      .from(infraHosts)
      .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.isActive, true))),
    db.select({
      id: alerts.id,
      severity: alerts.severity,
      title: alerts.title,
      triggerData: alerts.triggerData,
      createdAt: alerts.createdAt,
    })
      .from(alerts)
      .innerJoin(detections, eq(detections.id, alerts.detectionId))
      .where(and(eq(alerts.orgId, orgId), eq(detections.moduleId, 'infra'), gte(alerts.createdAt, dayAgo)))
      .orderBy(desc(alerts.createdAt))
      .limit(10),
  ]);

  const gradeDistribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let totalScore = 0;
  let scoredCount = 0;
  let recentScans = 0;

  for (const h of hosts) {
    if (h.lastScannedAt && h.lastScannedAt > dayAgo) recentScans++;
    if (h.currentScore !== null) {
      totalScore += h.currentScore;
      scoredCount++;
      if (h.currentScore >= 90) gradeDistribution.A++;
      else if (h.currentScore >= 80) gradeDistribution.B++;
      else if (h.currentScore >= 70) gradeDistribution.C++;
      else if (h.currentScore >= 50) gradeDistribution.D++;
      else gradeDistribution.F++;
    }
  }

  const [expiringRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(infraCertificates)
    .innerJoin(infraHosts, eq(infraHosts.id, infraCertificates.hostId))
    .where(and(eq(infraHosts.orgId, orgId), lte(infraCertificates.notAfter, thresholdDate)));

  return c.json({
    stats: {
      hostCount: hosts.length,
      averageScore: scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0,
      expiringCerts: expiringRow?.count ?? 0,
      recentScans,
      gradeDistribution,
    },
    recentAlerts: recentAlerts.map((a) => ({
      id: a.id,
      type: (a.triggerData as Record<string, string>)?.eventType ?? 'infra',
      hostname: (a.triggerData as Record<string, string>)?.hostname ?? '',
      severity: a.severity,
      message: a.title ?? '',
      createdAt: a.createdAt?.toISOString() ?? new Date().toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/dashboard — overview dashboard data
// ---------------------------------------------------------------------------

infraRouter.get('/dashboard', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();

  // 1. Hosts by grade
  const hosts = await db
    .select({
      id: infraHosts.id,
      hostname: infraHosts.hostname,
      currentScore: infraHosts.currentScore,
      isActive: infraHosts.isActive,
      lastScannedAt: infraHosts.lastScannedAt,
    })
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.isActive, true)));

  const gradeMap = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let totalScore = 0;
  let scoredCount = 0;
  for (const h of hosts) {
    if (h.currentScore !== null) {
      totalScore += h.currentScore;
      scoredCount++;
      if (h.currentScore >= 90) gradeMap.A++;
      else if (h.currentScore >= 80) gradeMap.B++;
      else if (h.currentScore >= 70) gradeMap.C++;
      else if (h.currentScore >= 50) gradeMap.D++;
      else gradeMap.F++;
    }
  }

  // 2. Expiring certificates (within 30 days)
  const thresholdDate = new Date(Date.now() + 30 * 86_400_000);
  const expiringCerts = await db
    .select({
      id: infraCertificates.id,
      hostname: infraHosts.hostname,
      subject: infraCertificates.subject,
      issuer: infraCertificates.issuer,
      notAfter: infraCertificates.notAfter,
    })
    .from(infraCertificates)
    .innerJoin(infraHosts, eq(infraHosts.id, infraCertificates.hostId))
    .where(and(
      eq(infraHosts.orgId, orgId),
      lte(infraCertificates.notAfter, thresholdDate),
    ))
    .orderBy(asc(infraCertificates.notAfter))
    .limit(20);

  // 3. Recently scanned (last 24h)
  const dayAgo = new Date(Date.now() - 86_400_000);
  const recentlyScanned = hosts.filter(
    (h) => h.lastScannedAt && h.lastScannedAt > dayAgo,
  ).length;

  return c.json({
    data: {
      hostsByGrade: gradeMap,
      expiringCerts,
      summary: {
        totalHosts: hosts.length,
        recentlyScanned,
        averageScore: scoredCount > 0 ? Math.round(totalScore / scoredCount) : null,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/findings — synthesized findings from DNS + WHOIS changes
// ---------------------------------------------------------------------------

infraRouter.get('/findings', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const hostId = c.req.query('hostId');
  const severity = c.req.query('severity');

  // DNS changes as findings
  const dnsConditions = [eq(infraHosts.orgId, orgId)];
  if (hostId) dnsConditions.push(eq(infraDnsChanges.hostId, hostId));
  if (severity) dnsConditions.push(eq(infraDnsChanges.severity, severity));

  const dnsFindings = await db
    .select({
      id: infraDnsChanges.id,
      hostId: infraDnsChanges.hostId,
      hostname: infraHosts.hostname,
      type: sql<string>`'dns_change'`,
      severity: infraDnsChanges.severity,
      detail: sql<string>`'DNS ' || ${infraDnsChanges.changeType} || ': ' || ${infraDnsChanges.recordType}`,
      detectedAt: infraDnsChanges.detectedAt,
    })
    .from(infraDnsChanges)
    .innerJoin(infraHosts, eq(infraHosts.id, infraDnsChanges.hostId))
    .where(and(...dnsConditions))
    .orderBy(desc(infraDnsChanges.detectedAt))
    .limit(limit)
    .offset(offset);

  // WHOIS changes as findings
  const whoisConditions = [eq(infraHosts.orgId, orgId)];
  if (hostId) whoisConditions.push(eq(infraWhoisChanges.hostId, hostId));

  const whoisFindings = await db
    .select({
      id: infraWhoisChanges.id,
      hostId: infraWhoisChanges.hostId,
      hostname: infraHosts.hostname,
      type: sql<string>`'whois_change'`,
      severity: sql<string>`'medium'`,
      detail: sql<string>`'WHOIS ' || ${infraWhoisChanges.fieldName} || ' changed'`,
      detectedAt: infraWhoisChanges.detectedAt,
    })
    .from(infraWhoisChanges)
    .innerJoin(infraHosts, eq(infraHosts.id, infraWhoisChanges.hostId))
    .where(and(...whoisConditions))
    .orderBy(desc(infraWhoisChanges.detectedAt))
    .limit(limit)
    .offset(offset);

  // Merge and sort by date
  const findings = [...dnsFindings, ...whoisFindings]
    .sort((a, b) => (b.detectedAt?.getTime() ?? 0) - (a.detectedAt?.getTime() ?? 0))
    .slice(0, limit);

  return c.json({ data: findings });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/changes — combined DNS + WHOIS change feed
// ---------------------------------------------------------------------------

infraRouter.get('/changes', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const limit = Math.min(100, parseInt(c.req.query('limit') ?? '50', 10));
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const hostId = c.req.query('hostId');
  const type = c.req.query('type');
  const severity = c.req.query('severity');

  const db = getDb();

  const dnsItems = (!type || type === 'dns_change') ? await db.select({
    id: infraDnsChanges.id, hostId: infraDnsChanges.hostId, hostname: infraHosts.hostname,
    type: sql<string>`'dns_change'`, field: infraDnsChanges.recordType,
    oldValue: infraDnsChanges.oldValue, newValue: infraDnsChanges.newValue,
    severity: infraDnsChanges.severity, detectedAt: infraDnsChanges.detectedAt,
  }).from(infraDnsChanges).innerJoin(infraHosts, eq(infraHosts.id, infraDnsChanges.hostId))
    .where(and(
      eq(infraHosts.orgId, orgId),
      ...(hostId ? [eq(infraDnsChanges.hostId, hostId)] : []),
      ...(severity ? [eq(infraDnsChanges.severity, severity)] : []),
    )).orderBy(desc(infraDnsChanges.detectedAt)).limit(limit) : [];

  const whoisItems = (!type || type === 'whois_change') ? await db.select({
    id: infraWhoisChanges.id, hostId: infraWhoisChanges.hostId, hostname: infraHosts.hostname,
    type: sql<string>`'whois_change'`, field: infraWhoisChanges.fieldName,
    oldValue: infraWhoisChanges.oldValue, newValue: infraWhoisChanges.newValue,
    severity: sql<string>`'medium'`, detectedAt: infraWhoisChanges.detectedAt,
  }).from(infraWhoisChanges).innerJoin(infraHosts, eq(infraHosts.id, infraWhoisChanges.hostId))
    .where(and(
      eq(infraHosts.orgId, orgId),
      ...(hostId ? [eq(infraWhoisChanges.hostId, hostId)] : []),
    )).orderBy(desc(infraWhoisChanges.detectedAt)).limit(limit) : [];

  const combined = [...dnsItems, ...whoisItems]
    .sort((a, b) => (b.detectedAt?.getTime() ?? 0) - (a.detectedAt?.getTime() ?? 0))
    .slice(offset, offset + limit);

  return c.json({ data: combined });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/certificates — cross-host certificate view
// ---------------------------------------------------------------------------

infraRouter.get('/certificates', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const hostId = c.req.query('hostId');

  const conditions = [eq(infraHosts.orgId, orgId)];
  if (hostId) conditions.push(eq(infraCertificates.hostId, hostId));

  const certs = await db
    .select({
      id: infraCertificates.id,
      hostId: infraCertificates.hostId,
      hostname: infraHosts.hostname,
      subject: infraCertificates.subject,
      issuer: infraCertificates.issuer,
      serialNumber: infraCertificates.serialNumber,
      notBefore: infraCertificates.notBefore,
      notAfter: infraCertificates.notAfter,
      chainValid: infraCertificates.chainValid,
      keyType: infraCertificates.keyType,
      keySize: infraCertificates.keySize,
      sanList: infraCertificates.sanList,
      observedAt: infraCertificates.observedAt,
    })
    .from(infraCertificates)
    .innerJoin(infraHosts, eq(infraHosts.id, infraCertificates.hostId))
    .where(and(...conditions))
    .orderBy(asc(infraCertificates.notAfter))
    .limit(limit)
    .offset(offset);

  return c.json({ data: certs });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/ct-logs — Certificate Transparency log entries
// ---------------------------------------------------------------------------

infraRouter.get('/ct-logs', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const hostId = c.req.query('hostId');
  const isNewOnly = c.req.query('isNew') === 'true';

  const conditions = [eq(infraHosts.orgId, orgId)];
  if (hostId) conditions.push(eq(infraCtLogEntries.hostId, hostId));
  if (isNewOnly) conditions.push(eq(infraCtLogEntries.isNew, true));

  const entries = await db
    .select({
      id: infraCtLogEntries.id,
      hostId: infraCtLogEntries.hostId,
      hostname: infraHosts.hostname,
      issuer: infraCtLogEntries.issuer,
      commonName: infraCtLogEntries.commonName,
      serialNumber: infraCtLogEntries.serialNumber,
      notBefore: infraCtLogEntries.notBefore,
      notAfter: infraCtLogEntries.notAfter,
      entryTimestamp: infraCtLogEntries.entryTimestamp,
      isNew: infraCtLogEntries.isNew,
      firstSeenAt: infraCtLogEntries.firstSeenAt,
    })
    .from(infraCtLogEntries)
    .innerJoin(infraHosts, eq(infraHosts.id, infraCtLogEntries.hostId))
    .where(and(...conditions))
    .orderBy(desc(infraCtLogEntries.firstSeenAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data: entries });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/infrastructure/map — geo map of infrastructure
// ---------------------------------------------------------------------------

infraRouter.get('/infrastructure/map', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  const db = getDb();

  const snaps = await db.select({
    hostId: infraSnapshots.hostId, hostname: infraHosts.hostname,
    ip: infraSnapshots.ipAddress, lat: infraSnapshots.geoLat, lon: infraSnapshots.geoLon,
    country: infraSnapshots.geoCountry, city: infraSnapshots.geoCity,
    cloudProvider: infraSnapshots.cloudProvider, asn: infraSnapshots.asn, asnOrg: infraSnapshots.asnOrg,
    scannedAt: infraSnapshots.scannedAt,
  })
    .from(infraSnapshots)
    .innerJoin(infraHosts, eq(infraHosts.id, infraSnapshots.hostId))
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.isActive, true)))
    .orderBy(desc(infraSnapshots.scannedAt));

  // Keep latest per host
  const seen = new Set<string>();
  const unique = snaps.filter((s) => { if (seen.has(s.hostId)) return false; seen.add(s.hostId); return true; });
  return c.json({ data: unique.filter((s) => s.lat !== null && s.lon !== null) });
});

// ---------------------------------------------------------------------------
// CDN provider routes
// ---------------------------------------------------------------------------

// GET /modules/infra/cdn-providers — list CDN provider configs for the org
infraRouter.get('/cdn-providers', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  const db = getDb();
  const configs = await db.select({
    id: infraCdnProviderConfigs.id, provider: infraCdnProviderConfigs.provider,
    displayName: infraCdnProviderConfigs.displayName, hostPattern: infraCdnProviderConfigs.hostPattern,
    isValid: infraCdnProviderConfigs.isValid, lastValidatedAt: infraCdnProviderConfigs.lastValidatedAt,
    createdAt: infraCdnProviderConfigs.createdAt,
  }).from(infraCdnProviderConfigs).where(eq(infraCdnProviderConfigs.orgId, orgId))
    .orderBy(infraCdnProviderConfigs.provider);
  return c.json({ data: configs });
});

// POST /modules/infra/cdn-providers — add a CDN provider config
const cdnProviderSchema = z.object({
  provider: z.enum(['cloudflare', 'cloudfront']),
  displayName: z.string().min(1).max(255),
  hostPattern: z.string().optional(),
  credentials: z.record(z.string()),
});

infraRouter.post('/cdn-providers', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);

  const body = cdnProviderSchema.parse(await c.req.json());
  const requiredFields: Record<string, string[]> = {
    cloudflare: ['apiToken', 'accountId'],
    cloudfront: ['accessKeyId', 'secretAccessKey', 'region'],
  };
  const missing = (requiredFields[body.provider] ?? []).filter((f) => !body.credentials[f]);
  if (missing.length > 0) return c.json({ error: `Missing credential fields: ${missing.join(', ')}` }, 422);

  const { encrypt } = await import('@sentinel/shared/crypto');
  const encryptedCredentials = encrypt(JSON.stringify(body.credentials));

  const db = getDb();
  const normalizedPattern = body.hostPattern?.trim().toLowerCase() || '*';
  const [config] = await db.insert(infraCdnProviderConfigs)
    .values({ orgId, provider: body.provider, displayName: body.displayName, hostPattern: normalizedPattern, encryptedCredentials, isValid: false })
    .onConflictDoUpdate({
      target: [infraCdnProviderConfigs.orgId, infraCdnProviderConfigs.provider, infraCdnProviderConfigs.hostPattern],
      set: { displayName: body.displayName, encryptedCredentials, isValid: false, lastValidatedAt: null },
    })
    .returning();
  return c.json({ data: { id: config.id, provider: config.provider, displayName: config.displayName, isValid: config.isValid } }, 201);
});

// DELETE /modules/infra/cdn-providers/:id — remove a CDN provider config
infraRouter.delete('/cdn-providers/:id', async (c) => {
  const orgId = c.get('orgId');
  const role = c.get('role');
  const configId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  if (role !== 'admin') return c.json({ error: 'Admin role required' }, 403);
  const db = getDb();
  const [deleted] = await db.delete(infraCdnProviderConfigs)
    .where(and(eq(infraCdnProviderConfigs.id, configId), eq(infraCdnProviderConfigs.orgId, orgId)))
    .returning({ id: infraCdnProviderConfigs.id });
  if (!deleted) return c.json({ error: 'CDN provider config not found' }, 404);
  return c.json({ data: { deleted: true } });
});

// POST /modules/infra/cdn-providers/:id/validate — validate CDN credentials
infraRouter.post('/cdn-providers/:id/validate', async (c) => {
  const orgId = c.get('orgId');
  const configId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  const db = getDb();
  const [config] = await db.select().from(infraCdnProviderConfigs)
    .where(and(eq(infraCdnProviderConfigs.id, configId), eq(infraCdnProviderConfigs.orgId, orgId))).limit(1);
  if (!config) return c.json({ error: 'CDN provider config not found' }, 404);

  const { decrypt } = await import('@sentinel/shared/crypto');
  const credentials = JSON.parse(decrypt(config.encryptedCredentials)) as Record<string, string>;

  let valid = false; let message = '';
  if (config.provider === 'cloudflare') {
    const { validateCredentials } = await import('./scanner/cdn/cloudflare.js');
    const result = await validateCredentials(credentials.apiToken, credentials.accountId);
    valid = result.valid; message = result.message;
  } else if (config.provider === 'cloudfront') {
    const { validateCredentials } = await import('./scanner/cdn/cloudfront.js');
    const result = await validateCredentials(credentials.accessKeyId, credentials.secretAccessKey, credentials.region);
    valid = result.valid; message = result.message;
  }

  await db.update(infraCdnProviderConfigs)
    .set({ isValid: valid, lastValidatedAt: new Date() })
    .where(and(eq(infraCdnProviderConfigs.id, configId), eq(infraCdnProviderConfigs.orgId, orgId)));

  return c.json({ data: { valid, message } });
});

// POST /modules/infra/cdn-providers/check-proxy — batch proxy detection
infraRouter.post('/cdn-providers/check-proxy', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);
  const body = z.object({ hostIds: z.array(z.string().uuid()) }).parse(await c.req.json());
  const { checkProxyStatusBatch } = await import('./scanner/cdn/proxy-detection.js');
  const results = await checkProxyStatusBatch(body.hostIds, orgId);
  return c.json({ data: results });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/templates — list available detection templates
// ---------------------------------------------------------------------------

infraRouter.get('/templates', async (c) => {
  const { templates } = await import('./templates/index.js');
  return c.json({ data: templates });
});

// ---------------------------------------------------------------------------
// GET /modules/infra/event-types — list event types this module handles
// ---------------------------------------------------------------------------

infraRouter.get('/event-types', async (c) => {
  const { eventTypes } = await import('./event-types.js');
  return c.json({ data: eventTypes });
});
