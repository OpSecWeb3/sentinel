/**
 * Scan orchestrator: runs all 8 scan steps via Promise.allSettled.
 *
 * Supports scan types: 'full', 'probe', 'emergency'.
 * Uses BullMQ job priorities: emergency=1, interactive=5, scheduled=10.
 * Partial results are valid -- each step runs independently and failures
 * in one step do not block others.
 */
import type { Redis } from 'ioredis';

import { logger as rootLogger } from '@sentinel/shared/logger';
import { acquireSlot, releaseSlot } from '@sentinel/shared/concurrency';

const log = rootLogger.child({ component: 'infra-scanner' });

import type {
  CertificateInfo,
  DnsHealthData,
  DnsRecord,
  HeaderInfo,
  InfraResult,
  ScanJobData,
  ScanType,
  StepName,
  StepResult,
  TlsInfo,
  WhoisData,
} from './types.js';
import dns from 'node:dns/promises';
import net from 'node:net';

import { runDnsRecordsStep } from './steps/dns-records.js';
import { runDnsHealthStep } from './steps/dns-health.js';
import { runCertificateStep } from './steps/certificate.js';
import { runTlsAnalysisStep } from './steps/tls-analysis.js';
import { runHeadersStep } from './steps/headers.js';
import { runCtLogsStep } from './steps/ct-logs.js';
import { runInfrastructureStep } from './steps/infrastructure.js';
import { runWhoisStep } from './steps/whois.js';
import { fetchVtSubdomains } from './steps/virustotal-subdomains.js';
import { calculateScore, applySuppressions, type FindingSuppression } from './scoring.js';
import { invalidateProxyStatusCache } from './cdn/proxy-detection.js';

// -------------------------------------------------------------------------
// Concurrency keys
// -------------------------------------------------------------------------

const SCAN_DEDUP_KEY_PREFIX = 'scan:inprogress:';
const SCAN_SLOT_GLOBAL_KEY = 'slot:scan:global';
const SCAN_SLOT_ORG_PREFIX = 'slot:scan:org:';

const MAX_GLOBAL_SCANS = 50;
const MAX_PER_ORG_SCANS = 10;

// -------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------

export interface ScanResult {
  hostId: string;
  hostName: string;
  scanType: ScanType;
  status: 'success' | 'partial' | 'error';
  score?: number;
  grade?: string;
  details: Record<string, unknown>;
  stepResults: StepResult[];
  errors: string[];
  startedAt: Date;
  completedAt: Date;
}

/**
 * Callbacks for persistence -- callers inject their DB/storage logic so the
 * orchestrator stays decoupled from any specific ORM or database.
 */
export interface ScanCallbacks {
  /** Load stored DNS records for change detection. */
  getStoredDnsRecords(hostId: string): Promise<DnsRecord[]>;

  /** Load stored WHOIS data for change detection. */
  getStoredWhoisData(hostId: string): Promise<WhoisData | null>;

  /** Load finding suppressions for score adjustment. */
  getSuppressions(hostId: string): Promise<FindingSuppression[]>;

  /** Persist the final scan result (ScanEvent + ScanStepResults + score). */
  saveScanResult(result: ScanResult): Promise<void>;

  /** Get proxy status for CDN-aware A/AAAA change suppression. */
  getProxyStatus?(hostId: string): Promise<{ isProxied: boolean; provider: string | null }>;

  /** Redis instance for concurrency limiting and deduplication. */
  redis?: Redis;
}

// -------------------------------------------------------------------------
// SSRF protection: validate resolved IPs are not private/internal
// -------------------------------------------------------------------------

const PRIVATE_RANGES_V4 = [
  { prefix: '10.', mask: 8 },
  { prefix: '172.', mask: 12, check: (ip: string) => { const b = parseInt(ip.split('.')[1], 10); return b >= 16 && b <= 31; } },
  { prefix: '192.168.', mask: 16 },
  { prefix: '100.64.', mask: 10, check: (ip: string) => { const b = parseInt(ip.split('.')[1], 10); return b >= 64 && b <= 127; } },
  { prefix: '169.254.', mask: 16 },
  { prefix: '127.', mask: 8 },
  { prefix: '0.', mask: 8 },
  { prefix: '198.18.', mask: 15, check: (ip: string) => { const b = parseInt(ip.split('.')[1], 10); return b === 18 || b === 19; } },
];

function isPrivateIpV4(ip: string): boolean {
  if (ip === '169.254.169.254') return true; // AWS metadata
  if (ip === '255.255.255.255') return true; // broadcast
  const a = parseInt(ip.split('.')[0], 10);
  if (a >= 240) return true; // reserved (RFC 1112)
  for (const range of PRIVATE_RANGES_V4) {
    if (ip.startsWith(range.prefix)) {
      if (range.check) return range.check(ip);
      return true;
    }
  }
  return false;
}

function isPrivateIpV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local (fe80::/10)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  // IPv4-mapped IPv6
  if (lower.startsWith('::ffff:')) {
    const v4Part = lower.slice(7);
    if (net.isIPv4(v4Part)) return isPrivateIpV4(v4Part);
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpV4(ip);
  if (net.isIPv6(ip)) return isPrivateIpV6(ip);
  return false;
}

/**
 * Resolve the target hostname and validate that none of the IPs are private.
 * Throws if the target resolves to any private/internal IP.
 */
async function validateResolvedIps(targetName: string): Promise<void> {
  const ips: string[] = [];

  try {
    const v4 = await dns.resolve4(targetName);
    ips.push(...v4);
  } catch (err) { log.debug({ err, targetName }, 'no A records'); }

  try {
    const v6 = await dns.resolve6(targetName);
    ips.push(...v6);
  } catch (err) { log.debug({ err, targetName }, 'no AAAA records'); }

  if (ips.length === 0) {
    throw new Error(`DNS resolution failed for ${targetName}: no A/AAAA records`);
  }

  const privateIps = ips.filter(isPrivateIp);
  if (privateIps.length > 0) {
    throw new Error(
      `SSRF blocked: ${targetName} resolves to private IP(s): ${privateIps.join(', ')}`,
    );
  }
}

// -------------------------------------------------------------------------
// Per-step retry wrapper
// -------------------------------------------------------------------------

const STEP_RETRY_COUNTS: Record<string, number> = {
  dns_records: 3,
  dns_health: 3,
  certificate: 2,
  tls_analysis: 2,
  headers: 2,
  ct_logs: 1,
  infrastructure: 2,
  whois: 2,
};

const STEP_TIMEOUT_MS = 60_000;

async function withRetry<T>(stepName: string, fn: () => Promise<T>): Promise<T> {
  const maxRetries = STEP_RETRY_COUNTS[stepName] ?? 1;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await Promise.race<T>([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Step ${stepName} timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS),
        ),
      ]);
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        // Brief backoff before retry
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// -------------------------------------------------------------------------
// Orchestrator
// -------------------------------------------------------------------------

/**
 * Run a full infrastructure scan for a host.
 *
 * Dispatches all 8 scan steps in parallel via Promise.allSettled. Partial
 * results are valid -- if some steps fail, scoring still works with the
 * available data. Stores a ScanEvent, per-step ScanStepResults, and a
 * ScoreHistory entry via the supplied callbacks.
 */
export async function runScan(data: ScanJobData, callbacks: ScanCallbacks): Promise<ScanResult> {
  const { hostId, targetName, scanType, isRoot, orgId } = data;
  const startedAt = new Date();
  const redis = callbacks.redis;

  // -- Deduplication -------------------------------------------------------
  if (redis) {
    const dedupKey = `${SCAN_DEDUP_KEY_PREFIX}${hostId}`;
    const inProgress = await redis.get(dedupKey);
    if (inProgress) {
      return earlyExit(hostId, targetName, scanType, startedAt, 'already_in_progress');
    }
    await redis.set(dedupKey, '1', 'PX', 10 * 60 * 1000);
  }

  // -- Concurrency slots ---------------------------------------------------
  if (redis && orgId) {
    const globalOk = await acquireSlot(redis, SCAN_SLOT_GLOBAL_KEY, MAX_GLOBAL_SCANS);
    if (!globalOk) {
      await redis.del(`${SCAN_DEDUP_KEY_PREFIX}${hostId}`);
      return earlyExit(hostId, targetName, scanType, startedAt, 'concurrency_limited');
    }

    const orgOk = await acquireSlot(redis, `${SCAN_SLOT_ORG_PREFIX}${orgId}`, MAX_PER_ORG_SCANS);
    if (!orgOk) {
      await releaseSlot(redis, SCAN_SLOT_GLOBAL_KEY);
      await redis.del(`${SCAN_DEDUP_KEY_PREFIX}${hostId}`);
      return earlyExit(hostId, targetName, scanType, startedAt, 'org_concurrency_limited');
    }
  }

  try {
    // -- SSRF validation: ensure target does not resolve to private IPs ----
    await validateResolvedIps(targetName);

    // -- Prepare stored data for change detection ---------------------------
    const [storedDnsRecords, storedWhoisData, proxyStatus] = await Promise.all([
      callbacks.getStoredDnsRecords(hostId),
      callbacks.getStoredWhoisData(hostId),
      callbacks.getProxyStatus?.(hostId) ?? Promise.resolve({ isProxied: false, provider: null }),
    ]);

    // -- Dispatch all 8 steps via Promise.allSettled with retry + timeout ---
    const settled = await Promise.allSettled<StepResult>([
      withRetry('dns_records', () => runDnsRecordsStep(targetName, storedDnsRecords, {
        isRoot,
        isProxied: proxyStatus.isProxied,
        knownProvider: proxyStatus.provider,
      })),
      withRetry('dns_health', () => runDnsHealthStep(targetName)),
      withRetry('certificate', () => runCertificateStep(targetName)),
      withRetry('tls_analysis', () => runTlsAnalysisStep(targetName)),
      withRetry('headers', () => runHeadersStep(targetName)),
      withRetry('ct_logs', () => runCtLogsStep(targetName, { isRoot, redis })),
      withRetry('infrastructure', () => runInfrastructureStep(targetName, { redis })),
      withRetry('whois', () => runWhoisStep(targetName, { isRoot, storedWhois: storedWhoisData })),
    ]);

    // -- Collect results ----------------------------------------------------
    const stepResults: StepResult[] = [];
    const errors: string[] = [];

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        stepResults.push(result.value);
        if (result.value.status === 'error' && result.value.error) {
          errors.push(`${result.value.step}: ${result.value.error}`);
        }
      } else {
        errors.push(`Step rejected: ${result.reason}`);
      }
    }

    // -- VT passive subdomain enrichment — interactive/emergency only, root domains only --
    if (isRoot && data.jobPriority && data.jobPriority !== 'scheduled') {
      try {
        const vtResult = await fetchVtSubdomains(targetName, { redis });
        if (vtResult.subdomains.length > 0) {
          // Attach to ct_logs step data bag; create one if ct_logs errored/skipped
          let ctStep = stepResults.find(s => s.step === 'ct_logs');
          if (ctStep) {
            if (!ctStep.data) ctStep.data = {};
          } else {
            // ct_logs step was rejected entirely — create a synthetic entry to carry VT data.
            // Use 'skipped' so it doesn't flip hasSuccess or feed into scoring via findStep.
            ctStep = { step: 'ct_logs', status: 'skipped', data: {}, startedAt: new Date(), completedAt: new Date() };
            stepResults.push(ctStep);
          }
          ctStep.data!.vtSubdomains = vtResult.subdomains;
          ctStep.data!.vtPagesFetched = vtResult.pagesFetched;
          ctStep.data!.vtRateLimited = vtResult.rateLimited;
        }
      } catch { /* non-fatal */ }
    }

    // -- Extract typed data for scoring -------------------------------------
    const dnsHealthData = extractDnsHealth(findStep(stepResults, 'dns_health'));
    const certInfo = extractCertInfo(findStep(stepResults, 'certificate'));
    const tlsInfo = extractTlsInfo(findStep(stepResults, 'tls_analysis'));
    const infraResults = extractInfraResults(findStep(stepResults, 'infrastructure'));

    // Invalidate proxy status cache after a successful infrastructure scan
    // so the next probe picks up fresh detection data.
    if (redis && findStep(stepResults, 'infrastructure')) {
      await invalidateProxyStatusCache(hostId, redis);
    }

    const headerInfo = extractHeaderInfo(findStep(stepResults, 'headers'));
    const whoisInfo = extractWhoisInfo(findStep(stepResults, 'whois'));

    // -- Score --------------------------------------------------------------
    const scoreResult = calculateScore(hostId, dnsHealthData, certInfo, tlsInfo, {
      infraResults,
      headerInfo,
      whoisInfo,
    });

    const suppressions = await callbacks.getSuppressions(hostId);
    const adjustedScore = applySuppressions(scoreResult, suppressions);

    // -- Build details from step data ---------------------------------------
    const details: Record<string, unknown> = {};
    for (const sr of stepResults) {
      if (sr.status !== 'skipped' && sr.data) {
        for (const [k, v] of Object.entries(sr.data)) {
          details[k] = v;
        }
      }
    }
    details.score = adjustedScore;
    details.grade = scoreResult.grade;
    details.deductions = scoreResult.deductions;
    details.breakdown = scoreResult.breakdown;

    const hasSuccess = stepResults.some((s) => s.status === 'success');
    const status = errors.length === 0 ? 'success' : hasSuccess ? 'partial' : 'error';

    const scanResult: ScanResult = {
      hostId,
      hostName: targetName,
      scanType,
      status,
      score: adjustedScore,
      grade: scoreResult.grade,
      details,
      stepResults,
      errors,
      startedAt,
      completedAt: new Date(),
    };

    // -- Persist ------------------------------------------------------------
    try {
      await callbacks.saveScanResult(scanResult);
    } catch (err) {
      log.error({ err, targetName }, 'failed to save scan result');
    }

    return scanResult;
  } finally {
    // -- Release concurrency slots and dedup lock ---------------------------
    if (redis) {
      await redis.del(`${SCAN_DEDUP_KEY_PREFIX}${hostId}`);
      if (orgId) {
        await releaseSlot(redis, SCAN_SLOT_GLOBAL_KEY).catch((err) => { log.debug({ err }, 'failed to release global scan slot'); });
        await releaseSlot(redis, `${SCAN_SLOT_ORG_PREFIX}${orgId}`).catch((err) => { log.debug({ err, orgId }, 'failed to release org scan slot'); });
      }
    }
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function earlyExit(
  hostId: string,
  hostName: string,
  scanType: ScanType,
  startedAt: Date,
  reason: string,
): ScanResult {
  return {
    hostId,
    hostName,
    scanType,
    status: 'error',
    details: { reason },
    stepResults: [],
    errors: [reason],
    startedAt,
    completedAt: new Date(),
  };
}

function findStep(results: StepResult[], step: StepName): StepResult | null {
  const found = results.find((r) => r.step === step);
  if (!found || found.status === 'skipped' || found.status === 'error') return null;
  return found;
}

function extractDnsHealth(result: StepResult | null): DnsHealthData | null {
  if (!result?.data) return null;
  const d = result.data;
  return {
    dnssecEnabled: (d.dnssecEnabled as boolean) ?? false,
    dnssecDetails: (d.dnssecDetails as string) ?? '{}',
    caaRecords: (d.caaRecords as string) ?? '[]',
    dmarcRecord: (d.dmarcRecord as string | null) ?? null,
    dmarcPolicy: (d.dmarcPolicy as string | null) ?? null,
    spfRecord: (d.spfRecord as string | null) ?? null,
    spfValid: (d.spfValid as boolean) ?? false,
    spfTooPermissive: d.spfTooPermissive as boolean,
    spfTooManyLookups: d.spfTooManyLookups as boolean,
    spfLookupCount: d.spfLookupCount as number,
    spfMissingTerminator: d.spfMissingTerminator as boolean,
    danglingCnames: (d.danglingCnames as string) ?? '[]',
  };
}

function extractCertInfo(result: StepResult | null): CertificateInfo | null {
  if (!result?.data) return null;
  const d = result.data;
  return {
    subject: (d.subject as string) ?? '',
    issuer: (d.issuer as string) ?? '',
    serialNumber: (d.serialNumber as string) ?? '',
    notBefore: (d.notBefore as string) ?? '',
    notAfter: (d.notAfter as string) ?? '',
    fingerprint: (d.fingerprint as string) ?? '',
    chainValid: (d.chainValid as boolean) ?? false,
    sanList: (d.sanList as string[]) ?? [],
    keyType: d.keyType as string,
    keySize: d.keySize as number,
    signatureAlgorithm: d.signatureAlgorithm as string,
    selfSigned: d.selfSigned as boolean,
    weakKey: d.weakKey as boolean,
    sha1Signature: d.sha1Signature as boolean,
  };
}

function extractTlsInfo(result: StepResult | null): TlsInfo | null {
  if (!result?.data) return null;
  const d = result.data;
  return {
    hasTls10: (d.hasTls10 as boolean) ?? false,
    hasTls11: (d.hasTls11 as boolean) ?? false,
    hasTls12: (d.hasTls12 as boolean) ?? false,
    hasTls13: (d.hasTls13 as boolean) ?? false,
    hasWeakCiphers: (d.hasWeakCiphers as boolean) ?? false,
    weakCipherList: (d.weakCipherList as string[]) ?? [],
    supportedVersions: (d.supportedVersions as string[]) ?? [],
  };
}

function extractInfraResults(result: StepResult | null): InfraResult[] | null {
  if (!result?.data) return null;
  return (result.data.results as InfraResult[]) ?? null;
}

function extractHeaderInfo(result: StepResult | null): HeaderInfo | null {
  if (!result?.data) return null;
  const d = result.data;
  return {
    hstsPresent: (d.hstsPresent as boolean) ?? false,
    hstsValue: (d.hstsValue as string | null) ?? null,
    cspPresent: (d.cspPresent as boolean) ?? false,
    cspValue: (d.cspValue as string | null) ?? null,
    xFrameOptions: (d.xFrameOptions as string | null) ?? null,
    xContentTypeOptions: (d.xContentTypeOptions as boolean) ?? false,
    referrerPolicy: (d.referrerPolicy as string | null) ?? null,
    permissionsPolicy: (d.permissionsPolicy as string | null) ?? null,
    serverHeaderPresent: (d.serverHeaderPresent as boolean) ?? false,
    serverHeaderValue: (d.serverHeaderValue as string | null) ?? null,
  };
}

function extractWhoisInfo(result: StepResult | null): WhoisData | null {
  if (!result?.data) return null;
  const d = result.data;
  return {
    registrar: (d.registrar as string | null) ?? null,
    registrationDate: (d.registrationDate as string | null) ?? null,
    expiryDate: (d.expiryDate as string | null) ?? null,
    updatedDate: (d.updatedDate as string | null) ?? null,
    nameServers: (d.nameServers as string) ?? '[]',
    status: (d.status as string) ?? '[]',
    dnssecSigned: (d.dnssecSigned as boolean) ?? false,
    rawWhois: (d.rawWhois as string | null) ?? null,
  };
}

// NOTE: Job handlers are defined in handlers.ts (single source of truth).
// The orchestrator only exports runScan and related types.
