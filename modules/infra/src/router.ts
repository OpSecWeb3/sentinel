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
  infraScanSchedules,
  infraCtLogEntries,
  infraWhoisChanges,
} from '@sentinel/db/schema/infra';
import { eq, and, desc, asc, lte, gte, sql } from '@sentinel/db';
import { alerts, detections } from '@sentinel/db/schema/core';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import type { AppEnv } from '@sentinel/shared/hono-types';

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
// GET /modules/infra/hosts — list monitored hosts for the org
// ---------------------------------------------------------------------------

infraRouter.get('/hosts', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();
  const hosts = await db
    .select({
      id: infraHosts.id,
      hostname: infraHosts.hostname,
      isRoot: infraHosts.isRoot,
      isActive: infraHosts.isActive,
      source: infraHosts.source,
      currentScore: infraHosts.currentScore,
      lastScannedAt: infraHosts.lastScannedAt,
      discoveredAt: infraHosts.discoveredAt,
      createdAt: infraHosts.createdAt,
    })
    .from(infraHosts)
    .where(and(eq(infraHosts.orgId, orgId), eq(infraHosts.isRoot, true)))
    .orderBy(infraHosts.hostname);

  return c.json({ data: hosts });
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
// GET /modules/infra/hosts/:id — host detail with latest scan + cert info
// ---------------------------------------------------------------------------

infraRouter.get('/hosts/:id', async (c) => {
  const orgId = c.get('orgId');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

  const db = getDb();

  const [host] = await db
    .select()
    .from(infraHosts)
    .where(and(eq(infraHosts.id, hostId), eq(infraHosts.orgId, orgId)))
    .limit(1);

  if (!host) return c.json({ error: 'Host not found' }, 404);

  // Latest scan
  const [latestScan] = await db
    .select()
    .from(infraScanEvents)
    .where(eq(infraScanEvents.hostId, hostId))
    .orderBy(desc(infraScanEvents.startedAt))
    .limit(1);

  // Latest certificate
  const [latestCert] = await db
    .select()
    .from(infraCertificates)
    .where(eq(infraCertificates.hostId, hostId))
    .orderBy(desc(infraCertificates.observedAt))
    .limit(1);

  // Latest score
  const [latestScore] = await db
    .select()
    .from(infraScoreHistory)
    .where(eq(infraScoreHistory.hostId, hostId))
    .orderBy(desc(infraScoreHistory.recordedAt))
    .limit(1);

  // Scan schedule
  const [schedule] = await db
    .select()
    .from(infraScanSchedules)
    .where(eq(infraScanSchedules.hostId, hostId))
    .limit(1);

  return c.json({
    data: {
      host,
      latestScan: latestScan ?? null,
      latestCertificate: latestCert ?? null,
      latestScore: latestScore ?? null,
      schedule: schedule
        ? {
            ...schedule,
            scanIntervalHours: Math.round(schedule.intervalMinutes / 60),
          }
        : null,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /modules/infra/hosts/:id/scan — trigger a manual scan
// ---------------------------------------------------------------------------

infraRouter.post('/hosts/:id/scan', async (c) => {
  const orgId = c.get('orgId');
  const hostId = c.req.param('id');
  if (!orgId) return c.json({ error: 'Organisation required' }, 403);

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
