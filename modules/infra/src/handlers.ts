/**
 * Infrastructure module BullMQ job handlers.
 *
 * Bridges BullMQ jobs to the scanner orchestrator, providing the
 * ScanCallbacks that connect the orchestrator to the database.
 */
import type { Job } from 'bullmq';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { getDb } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import {
  infraHosts,
  infraScanEvents,
  infraScanStepResults,
  infraScanSchedules,
  infraScoreHistory,
  infraDnsRecords,
  infraDnsChanges,
  infraDnsHealthChecks,
  infraCertificates,
  infraTlsAnalyses,
  infraHttpHeaderChecks,
  infraSnapshots,
  infraWhoisRecords,
  infraWhoisChanges,
  infraFindingSuppressions,
  infraReachabilityChecks,
} from '@sentinel/db/schema/infra';
import { eq, and, lte, desc } from '@sentinel/db';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { getChildResults } from '@sentinel/shared/fan-out';
import type { ScanCallbacks, ScanResult } from './scanner/orchestrator.js';
import type { DnsRecord, WhoisData } from './scanner/types.js';
import type { FindingSuppression } from './scanner/scoring.js';
import { normalizeScanResult, normalizeProbeResult } from './normalizer.js';

const log = rootLogger.child({ component: 'infra' });

// ---------------------------------------------------------------------------
// Shared ScanCallbacks factory
// ---------------------------------------------------------------------------

function createScanCallbacks(): ScanCallbacks {
  const db = getDb();

  return {
    async getStoredDnsRecords(hostId: string): Promise<DnsRecord[]> {
      const rows = await db
        .select({ recordType: infraDnsRecords.recordType, recordValue: infraDnsRecords.recordValue })
        .from(infraDnsRecords)
        .where(eq(infraDnsRecords.hostId, hostId));
      return rows.map((r) => ({ recordType: r.recordType, recordValue: r.recordValue }));
    },

    async getStoredWhoisData(hostId: string): Promise<WhoisData | null> {
      const [row] = await db
        .select()
        .from(infraWhoisRecords)
        .where(eq(infraWhoisRecords.hostId, hostId))
        .orderBy(desc(infraWhoisRecords.checkedAt))
        .limit(1);

      if (!row) return null;
      return {
        registrar: row.registrar,
        registrationDate: row.registrationDate?.toISOString() ?? null,
        expiryDate: row.expiryDate?.toISOString() ?? null,
        updatedDate: row.updatedDate?.toISOString() ?? null,
        nameServers: JSON.stringify(row.nameServers),
        status: JSON.stringify(row.status),
        dnssecSigned: row.dnssecSigned,
        rawWhois: row.rawWhois,
      };
    },

    async getSuppressions(hostId: string): Promise<FindingSuppression[]> {
      const rows = await db
        .select({ category: infraFindingSuppressions.category, issue: infraFindingSuppressions.issue })
        .from(infraFindingSuppressions)
        .where(eq(infraFindingSuppressions.hostId, hostId));
      return rows;
    },

    async saveScanResult(result: ScanResult): Promise<void> {
      // Create scan event
      const [scanEvent] = await db
        .insert(infraScanEvents)
        .values({
          hostId: result.hostId,
          scanType: result.scanType,
          status: result.status,
          details: result.details,
          startedAt: result.startedAt,
          completedAt: result.completedAt,
        })
        .returning();

      // Persist step results
      for (const step of result.stepResults) {
        await db.insert(infraScanStepResults).values({
          scanEventId: scanEvent.id,
          stepType: step.step,
          status: step.status,
          resultData: step.data ?? null,
          errorMessage: step.error ?? null,
          startedAt: step.startedAt,
          completedAt: step.completedAt ?? new Date(),
        });
      }

      // Record score history
      if (result.score !== undefined && result.grade) {
        await db.insert(infraScoreHistory).values({
          hostId: result.hostId,
          score: result.score,
          grade: result.grade,
          breakdown: result.details.breakdown ?? {},
          deductions: result.details.deductions ?? [],
          recordedAt: new Date(),
        });
      }

      // Update host denormalized state
      if (result.score !== undefined) {
        await db
          .update(infraHosts)
          .set({ currentScore: result.score, lastScannedAt: result.completedAt })
          .where(eq(infraHosts.id, result.hostId));
      }

      // -----------------------------------------------------------------
      // Persist step-specific data to entity tables
      // -----------------------------------------------------------------
      const hostId = result.hostId;
      const stepMap = new Map(result.stepResults.map((s) => [s.step, s]));

      // -- DNS records: delete old + insert new --
      const dnsStep = stepMap.get('dns_records');
      if (dnsStep?.status === 'success' && dnsStep.data) {
        const records = dnsStep.data.records as Array<{ recordType: string; recordValue: string; ttl?: number }> | undefined;
        if (records && records.length > 0) {
          await db.delete(infraDnsRecords).where(eq(infraDnsRecords.hostId, hostId));
          await db.insert(infraDnsRecords).values(
            records.map((r) => ({
              hostId,
              recordType: r.recordType,
              recordValue: r.recordValue,
              ttl: r.ttl ?? null,
              observedAt: new Date(),
            })),
          );
        }

        // DNS changes
        const changes = dnsStep.data.changes as Array<{ recordType: string; oldValue?: string | null; newValue?: string | null; changeType: string; severity?: string }> | undefined;
        if (changes && changes.length > 0) {
          await db.insert(infraDnsChanges).values(
            changes.map((c) => ({
              hostId,
              recordType: c.recordType,
              oldValue: c.oldValue ?? null,
              newValue: c.newValue ?? null,
              changeType: c.changeType,
              severity: c.severity ?? null,
              detectedAt: new Date(),
            })),
          );
        }
      }

      // -- DNS health: upsert by hostId --
      const dnsHealthStep = stepMap.get('dns_health');
      if (dnsHealthStep?.status === 'success' && dnsHealthStep.data) {
        const d = dnsHealthStep.data;
        await db.insert(infraDnsHealthChecks).values({
          hostId,
          dnssecEnabled: (d.dnssecEnabled as boolean) ?? false,
          dnssecDetails: d.dnssecDetails ? (typeof d.dnssecDetails === 'string' ? JSON.parse(d.dnssecDetails as string) : d.dnssecDetails) : {},
          caaRecords: d.caaRecords ? (typeof d.caaRecords === 'string' ? JSON.parse(d.caaRecords as string) : d.caaRecords) : [],
          dmarcRecord: (d.dmarcRecord as string | null) ?? null,
          dmarcPolicy: (d.dmarcPolicy as string | null) ?? null,
          spfRecord: (d.spfRecord as string | null) ?? null,
          spfValid: (d.spfValid as boolean) ?? false,
          danglingCnames: d.danglingCnames ? (typeof d.danglingCnames === 'string' ? JSON.parse(d.danglingCnames as string) : d.danglingCnames) : [],
          checkedAt: new Date(),
        });
      }

      // -- Certificates: upsert by hostId + fingerprint --
      const certStep = stepMap.get('certificate');
      if (certStep?.status === 'success' && certStep.data) {
        const c = certStep.data;
        await db.insert(infraCertificates).values({
          hostId,
          serialNumber: (c.serialNumber as string) ?? '',
          subject: (c.subject as string) ?? '',
          issuer: (c.issuer as string) ?? '',
          notBefore: new Date(c.notBefore as string),
          notAfter: new Date(c.notAfter as string),
          fingerprint: (c.fingerprint as string) ?? '',
          chainValid: (c.chainValid as boolean) ?? false,
          sanList: (c.sanList as string[]) ?? [],
          keyType: (c.keyType as string) ?? null,
          keySize: (c.keySize as number) ?? null,
          observedAt: new Date(),
        }).onConflictDoUpdate({
          target: [infraCertificates.hostId, infraCertificates.fingerprint],
          set: {
            chainValid: (c.chainValid as boolean) ?? false,
            observedAt: new Date(),
          },
        });
      }

      // -- TLS analysis: insert new entry per scan --
      const tlsStep = stepMap.get('tls_analysis');
      if (tlsStep?.status === 'success' && tlsStep.data) {
        const t = tlsStep.data;
        await db.insert(infraTlsAnalyses).values({
          hostId,
          tlsVersions: (t.supportedVersions as string[]) ?? [],
          cipherSuites: [],
          hasTls13: (t.hasTls13 as boolean) ?? false,
          hasTls12: (t.hasTls12 as boolean) ?? false,
          hasTls11: (t.hasTls11 as boolean) ?? false,
          hasTls10: (t.hasTls10 as boolean) ?? false,
          hasWeakCiphers: (t.hasWeakCiphers as boolean) ?? false,
          weakCipherList: (t.weakCipherList as string[]) ?? [],
          checkedAt: new Date(),
        });
      }

      // -- HTTP headers: insert new entry per scan --
      const headerStep = stepMap.get('headers');
      if (headerStep?.status === 'success' && headerStep.data) {
        const h = headerStep.data;
        await db.insert(infraHttpHeaderChecks).values({
          hostId,
          hstsPresent: (h.hstsPresent as boolean) ?? false,
          cspPresent: (h.cspPresent as boolean) ?? false,
          cspHeader: (h.cspValue as string | null) ?? null,
          xFrameOptions: (h.xFrameOptions as string | null) ?? null,
          xContentTypeOptions: (h.xContentTypeOptions as boolean) ?? false,
          referrerPolicy: (h.referrerPolicy as string | null) ?? null,
          permissionsPolicyPresent: (h.permissionsPolicy as string | null) !== null,
          permissionsPolicyHeader: (h.permissionsPolicy as string | null) ?? null,
          serverHeaderPresent: (h.serverHeaderPresent as boolean) ?? false,
          serverHeaderValue: (h.serverHeaderValue as string | null) ?? null,
          checkedAt: new Date(),
        });
      }

      // -- Infrastructure snapshots: insert new per IP --
      const infraStep = stepMap.get('infrastructure');
      if (infraStep?.status === 'success' && infraStep.data) {
        const infraResults = infraStep.data.results as Array<{
          ip: string; version: number; reverseDns?: string | null; cloudProvider?: string | null;
          ports?: Array<{ port: number; open: boolean; service?: string }>;
          geoCountry?: string | null; geoCity?: string | null; geoLat?: number | null; geoLon?: number | null;
          asn?: string | null; asnOrg?: string | null;
        }> | undefined;
        if (infraResults && infraResults.length > 0) {
          await db.insert(infraSnapshots).values(
            infraResults.map((r) => ({
              hostId,
              ipAddress: r.ip,
              ipVersion: r.version,
              geoCountry: r.geoCountry ?? null,
              geoCity: r.geoCity ?? null,
              geoLat: r.geoLat ?? null,
              geoLon: r.geoLon ?? null,
              cloudProvider: r.cloudProvider ?? null,
              reverseDnsName: r.reverseDns ?? null,
              openPorts: (r.ports ?? []).filter((p) => p.open).map((p) => ({ port: p.port, service: p.service })),
              asn: r.asn ?? null,
              asnOrg: r.asnOrg ?? null,
              scannedAt: new Date(),
            })),
          );
        }
      }

      // -- WHOIS records: insert new entry --
      const whoisStep = stepMap.get('whois');
      if (whoisStep?.status === 'success' && whoisStep.data) {
        const w = whoisStep.data;
        await db.insert(infraWhoisRecords).values({
          hostId,
          registrar: (w.registrar as string | null) ?? null,
          registrationDate: w.registrationDate ? new Date(w.registrationDate as string) : null,
          expiryDate: w.expiryDate ? new Date(w.expiryDate as string) : null,
          updatedDate: w.updatedDate ? new Date(w.updatedDate as string) : null,
          nameServers: w.nameServers ? (typeof w.nameServers === 'string' ? JSON.parse(w.nameServers as string) : w.nameServers) : [],
          status: w.status ? (typeof w.status === 'string' ? JSON.parse(w.status as string) : w.status) : [],
          dnssecSigned: (w.dnssecSigned as boolean) ?? false,
          rawWhois: (w.rawWhois as string | null) ?? null,
          checkedAt: new Date(),
        });

        // WHOIS changes
        const whoisChanges = w.whoisChanges as Array<{ fieldName: string; oldValue?: string | null; newValue?: string | null }> | undefined;
        if (whoisChanges && whoisChanges.length > 0) {
          await db.insert(infraWhoisChanges).values(
            whoisChanges.map((c) => ({
              hostId,
              fieldName: c.fieldName,
              oldValue: c.oldValue ?? null,
              newValue: c.newValue ?? null,
              detectedAt: new Date(),
            })),
          );
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// infra.scan — full scan job
// ---------------------------------------------------------------------------

export const scanHandler: JobHandler = {
  jobName: 'infra.scan',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { hostId, orgId, hostname, priority } = job.data as {
      hostId: string;
      orgId: string;
      hostname: string;
      priority?: string;
    };

    const { runScan } = await import('./scanner/orchestrator.js');

    const callbacks = createScanCallbacks();
    const result = await runScan(
      {
        hostId,
        targetName: hostname,
        scanType: priority === 'emergency' ? 'emergency' : 'full',
        isRoot: true,
        orgId,
      },
      callbacks,
    );

    // Normalize scan results into platform events and enqueue for evaluation
    const db = getDb();
    const normalized = normalizeScanResult(result, orgId);
    const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);

    for (const evt of normalized) {
      const [inserted] = await db
        .insert(events)
        .values({
          orgId,
          moduleId: 'infra',
          eventType: evt.eventType,
          externalId: null,
          payload: evt.payload,
          occurredAt: new Date(),
        })
        .returning();

      await eventsQueue.add('event.evaluate', { eventId: inserted.id });
    }

    log.info(
      { jobId: job.id, hostname, status: result.status, score: result.score ?? null, eventCount: normalized.length },
      'scan job complete',
    );
  },
};

// ---------------------------------------------------------------------------
// infra.probe — lightweight reachability probe
// ---------------------------------------------------------------------------

export const probeHandler: JobHandler = {
  jobName: 'infra.probe',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { hostId, orgId, hostname } = job.data as {
      hostId: string;
      orgId: string;
      hostname: string;
    };

    const { probeHost } = await import('./scanner/probe.js');
    const callbacks = createScanCallbacks();

    const storedRecords = await callbacks.getStoredDnsRecords(hostId);
    const result = await probeHost({
      hostId,
      domain: hostname,
      storedRecords,
    });

    // Store probe result
    const db = getDb();
    await db.insert(infraReachabilityChecks).values({
      hostId,
      dnsResolved: result.dnsResolved,
      isReachable: result.isReachable,
      httpStatus: result.httpStatus,
      responseTimeMs: result.responseTimeMs,
      dnsChanged: result.dnsChanged,
      checkedAt: new Date(),
    });

    // Normalize into platform events
    const normalized = await normalizeProbeResult(result, orgId);
    const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);

    for (const evt of normalized) {
      const [inserted] = await db
        .insert(events)
        .values({
          orgId,
          moduleId: 'infra',
          eventType: evt.eventType,
          externalId: null,
          payload: evt.payload,
          occurredAt: new Date(),
        })
        .returning();

      await eventsQueue.add('event.evaluate', { eventId: inserted.id });
    }

    log.info(
      { jobId: job.id, hostname, reachable: result.isReachable, responseTimeMs: result.responseTimeMs ?? null, eventCount: normalized.length },
      'probe job complete',
    );
  },
};

// ---------------------------------------------------------------------------
// infra.schedule.load — periodic schedule loader
// ---------------------------------------------------------------------------

export const scheduleLoaderHandler: JobHandler = {
  jobName: 'infra.schedule.load',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(_job: Job) {
    const db = getDb();
    const now = new Date();
    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);

    // Find hosts with due full scans
    const dueScans = await db
      .select({
        scheduleId: infraScanSchedules.id,
        hostId: infraScanSchedules.hostId,
        intervalMinutes: infraScanSchedules.intervalMinutes,
        hostname: infraHosts.hostname,
        orgId: infraHosts.orgId,
      })
      .from(infraScanSchedules)
      .innerJoin(infraHosts, eq(infraScanSchedules.hostId, infraHosts.id))
      .where(
        and(
          eq(infraScanSchedules.enabled, true),
          eq(infraHosts.isActive, true),
          lte(infraScanSchedules.nextRunAt, now),
        ),
      );

    for (const row of dueScans) {
      await queue.add('infra.scan', {
        hostId: row.hostId,
        orgId: row.orgId,
        hostname: row.hostname,
        priority: 'scheduled',
      });

      const nextRun = new Date(now.getTime() + row.intervalMinutes * 60_000);
      await db
        .update(infraScanSchedules)
        .set({ lastRunAt: now, nextRunAt: nextRun })
        .where(eq(infraScanSchedules.id, row.scheduleId));
    }

    // Find hosts with due probes
    const dueProbes = await db
      .select({
        scheduleId: infraScanSchedules.id,
        hostId: infraScanSchedules.hostId,
        probeIntervalMinutes: infraScanSchedules.probeIntervalMinutes,
        hostname: infraHosts.hostname,
        orgId: infraHosts.orgId,
      })
      .from(infraScanSchedules)
      .innerJoin(infraHosts, eq(infraScanSchedules.hostId, infraHosts.id))
      .where(
        and(
          eq(infraScanSchedules.probeEnabled, true),
          eq(infraHosts.isActive, true),
          lte(infraScanSchedules.probeNextRunAt, now),
        ),
      );

    for (const row of dueProbes) {
      await queue.add('infra.probe', {
        hostId: row.hostId,
        orgId: row.orgId,
        hostname: row.hostname,
      });

      const nextRun = new Date(now.getTime() + row.probeIntervalMinutes * 60_000);
      await db
        .update(infraScanSchedules)
        .set({ probeLastRunAt: now, probeNextRunAt: nextRun })
        .where(eq(infraScanSchedules.id, row.scheduleId));
    }

    if (dueScans.length > 0 || dueProbes.length > 0) {
      log.info(
        { scanCount: dueScans.length, probeCount: dueProbes.length },
        'schedule.load: enqueued scans and probes',
      );
    }
  },
};

// ---------------------------------------------------------------------------
// infra.scan.aggregate — fan-in handler for distributed scan mode
// Aggregates results from individual scan step jobs (alternative to
// in-process Promise.allSettled orchestrator).
// ---------------------------------------------------------------------------

interface ScanStepChildResult {
  step: string;
  status: 'success' | 'error';
  data?: Record<string, unknown>;
  error?: string;
}

export const scanAggregateHandler: JobHandler = {
  jobName: 'infra.scan.aggregate',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { hostId, orgId, hostname, scanType } = job.data as {
      hostId: string;
      orgId: string;
      hostname: string;
      scanType: string;
    };

    const fanIn = await getChildResults<ScanStepChildResult>(job);
    const stepResults = Object.values(fanIn.childResults);

    const successCount = stepResults.filter((r) => r.status === 'success').length;
    const errorCount = stepResults.filter((r) => r.status === 'error').length;

    // Determine overall scan status
    const status = errorCount === stepResults.length
      ? 'error'
      : errorCount > 0
        ? 'partial'
        : 'success';

    // Build aggregated result for persistence via existing callbacks
    const callbacks = createScanCallbacks();
    const aggregatedResult: ScanResult = {
      hostId,
      hostName: hostname,
      scanType: scanType as 'full' | 'probe' | 'emergency',
      status,
      details: {
        steps: stepResults,
        distributedMode: true,
      },
      stepResults: stepResults.map((r) => ({
        step: r.step,
        status: r.status,
        data: r.data,
        error: r.error,
        startedAt: new Date(),
        completedAt: new Date(),
      })),
      errors: stepResults
        .filter((r) => r.error)
        .map((r) => `${r.step}: ${r.error}`),
      startedAt: new Date(job.timestamp),
      completedAt: new Date(),
    };

    await callbacks.saveScanResult(aggregatedResult);

    // Normalize and enqueue for rule evaluation
    const db = getDb();
    const normalized = normalizeScanResult(aggregatedResult, orgId);
    const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);

    for (const evt of normalized) {
      const [inserted] = await db
        .insert(events)
        .values({
          orgId,
          moduleId: 'infra',
          eventType: evt.eventType,
          externalId: null,
          payload: evt.payload,
          occurredAt: new Date(),
        })
        .returning();

      await eventsQueue.add('event.evaluate', { eventId: inserted.id });
    }

    log.info(
      { hostname, successCount, totalSteps: stepResults.length, status, eventCount: normalized.length },
      'scan.aggregate complete',
    );
  },
};
