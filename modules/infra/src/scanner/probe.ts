/**
 * Lightweight probe scan: DNS resolve + HTTP reachability + DNS change detection.
 *
 * Runs on a tight interval (1-5 min) to catch outages and DNS changes fast.
 * If an alert fires, enqueues an emergency full scan for the domain.
 */
import dns from 'node:dns/promises';

import { logger as rootLogger } from '@sentinel/shared/logger';
import { escalate, ESCALATION_PRIORITIES } from '@sentinel/shared/escalation';

const log = rootLogger.child({ component: 'infra-probe' });
import type { DnsChange, DnsRecord, ProbeResult, StepResult } from './types.js';
import { resolveDnsRecords, detectDnsChanges } from './steps/dns-records.js';
import { isPrivateIp } from './orchestrator.js';

const HTTP_TIMEOUT_MS = 5_000;

// -------------------------------------------------------------------------
// HTTP reachability check (uses resolved IP to prevent DNS rebinding)
// -------------------------------------------------------------------------

interface HttpPingResult {
  isReachable: boolean;
  httpStatus: number | null;
  responseTimeMs: number | null;
  errorMessage: string | null;
}

/**
 * HTTP reachability check. Uses the pre-resolved IP address to connect,
 * setting the Host header to the original domain. This prevents DNS rebinding
 * attacks where the second resolution could point to a different (internal) IP.
 */
async function httpPing(domain: string, resolvedIp: string | null): Promise<HttpPingResult> {
  const result: HttpPingResult = {
    isReachable: false,
    httpStatus: null,
    responseTimeMs: null,
    errorMessage: null,
  };

  // If we have a resolved IP, use it directly; otherwise fall back to domain
  const target = resolvedIp ?? domain;

  // Validate resolved IP is not private
  if (resolvedIp && isPrivateIp(resolvedIp)) {
    result.errorMessage = `SSRF blocked: resolved IP ${resolvedIp} is private`;
    return result;
  }

  for (const scheme of ['https', 'http'] as const) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

      // When using resolved IP, connect to IP but set Host header to domain
      const url = resolvedIp
        ? `${scheme}://${resolvedIp}`
        : `${scheme}://${domain}`;

      const start = performance.now();
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: resolvedIp ? { Host: domain } : {},
      });
      const elapsedMs = Math.round(performance.now() - start);

      clearTimeout(timeoutId);

      result.httpStatus = response.status;
      result.responseTimeMs = elapsedMs;
      result.isReachable = response.status >= 200 && response.status < 500;
      return result;
    } catch (err) {
      result.errorMessage = `${scheme}: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
  }

  return result;
}

// -------------------------------------------------------------------------
// Probe runner
// -------------------------------------------------------------------------

export interface ProbeOptions {
  hostId: string;
  domain: string;
  storedRecords: DnsRecord[];
  isProxied?: boolean;
  knownProvider?: string | null;
  /** Callback invoked when the probe detects an alert condition. */
  onAlert?: (probeResult: ProbeResult) => Promise<void>;
}

/**
 * Run a lightweight probe for a single host.
 *
 * 1. DNS resolve all record types (A, AAAA, CNAME, MX, NS, TXT, SOA)
 * 2. HTTP reachability (HEAD request with response time)
 * 3. DNS change detection (compare against stored records)
 * 4. If alert fires, enqueue emergency full scan
 */
export async function probeHost(options: ProbeOptions): Promise<ProbeResult> {
  const { hostId, domain, storedRecords, isProxied, knownProvider } = options;

  // 1. DNS resolution
  const { records, failedTypes } = await resolveDnsRecords(domain);
  const dnsResolved = records.some(
    (r) => r.recordType === 'A' || r.recordType === 'AAAA',
  );

  // Extract the first resolved A/AAAA IP for use in HTTP ping (prevents DNS rebinding)
  const resolvedIp = records.find(
    (r) => r.recordType === 'A' || r.recordType === 'AAAA',
  )?.recordValue ?? null;

  // 2. HTTP reachability (uses resolved IP to prevent DNS rebinding)
  const httpResult = await httpPing(domain, resolvedIp);

  // 3. DNS change detection
  const changeResult = detectDnsChanges(records, storedRecords, failedTypes, {
    isProxied,
    knownProvider,
  });

  const dnsChanged = changeResult.changes.length > 0;

  const probeResult: ProbeResult = {
    hostId,
    hostName: domain,
    dnsResolved,
    isReachable: httpResult.isReachable,
    httpStatus: httpResult.httpStatus,
    responseTimeMs: httpResult.responseTimeMs,
    dnsChanged,
    dnsChangesCount: changeResult.changes.length,
    dnsChanges: changeResult.changes,
    alerted: false,
  };

  // 4. Evaluate alert conditions
  const shouldAlert = !dnsResolved || !httpResult.isReachable || dnsChanged;

  if (shouldAlert) {
    probeResult.alerted = true;

    // Invoke custom alert handler if provided
    if (options.onAlert) {
      try {
        await options.onAlert(probeResult);
      } catch (err) {
        log.error({ err, domain }, 'probe alert callback failed');
      }
    }

    // Enqueue emergency full scan
    try {
      await escalate('infra.scan', {
        hostId,
        targetName: domain,
        scanType: 'emergency',
        isRoot: true,
      }, { priority: ESCALATION_PRIORITIES.emergency });
      log.info({ domain, hostId }, 'emergency full scan enqueued');
    } catch (err) {
      log.error({ err, domain, hostId }, 'failed to enqueue emergency scan');
    }
  }

  return probeResult;
}

/**
 * Probe result summary for storing in the database.
 */
export function probeResultToRecord(result: ProbeResult): Record<string, unknown> {
  return {
    hostId: result.hostId,
    dnsResolved: result.dnsResolved,
    isReachable: result.isReachable,
    httpStatus: result.httpStatus,
    responseTimeMs: result.responseTimeMs,
    dnsChanged: result.dnsChanged,
    dnsChangesCount: result.dnsChangesCount,
    errorMessage: null,
    checkedAt: new Date().toISOString(),
  };
}
