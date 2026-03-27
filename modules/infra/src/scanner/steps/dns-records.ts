/**
 * Step 1: DNS record resolution + change detection.
 *
 * Resolves A, AAAA, MX, NS, TXT, CNAME, SOA records using node:dns/promises.
 * Compares against previously stored records to detect changes.
 * CDN-aware suppression for A/AAAA changes when IPs belong to same provider.
 */
import dns from 'node:dns/promises';

import type { DnsChange, DnsRecord, Severity, StepResult } from '../types.js';

const RECORD_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA'] as const;

/** Well-known CDN CNAME suffixes used for edge-IP-rotation suppression. */
const CDN_CNAME_PATTERNS: Record<string, string[]> = {
  cloudflare: ['.cdn.cloudflare.net'],
  cloudfront: ['.cloudfront.net'],
  fastly: ['.fastly.net', '.fastlylb.net'],
  akamai: ['.akamaiedge.net', '.akamai.net', '.edgekey.net'],
};

// -------------------------------------------------------------------------
// DNS resolution
// -------------------------------------------------------------------------

interface ResolveResult {
  records: DnsRecord[];
  failedTypes: Set<string>;
}

async function resolveType(domain: string, rtype: string): Promise<DnsRecord[]> {
  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  try {
    switch (rtype) {
      case 'A': {
        const addrs = await resolver.resolve4(domain, { ttl: true });
        return addrs.map((a) => ({ recordType: 'A', recordValue: a.address, ttl: a.ttl }));
      }
      case 'AAAA': {
        const addrs = await resolver.resolve6(domain, { ttl: true });
        return addrs.map((a) => ({ recordType: 'AAAA', recordValue: a.address, ttl: a.ttl }));
      }
      case 'MX': {
        const entries = await resolver.resolveMx(domain);
        return entries.map((mx) => ({
          recordType: 'MX',
          recordValue: `${mx.priority} ${mx.exchange}`,
        }));
      }
      case 'NS': {
        const ns = await resolver.resolveNs(domain);
        return ns.map((n) => ({ recordType: 'NS', recordValue: n }));
      }
      case 'TXT': {
        const txt = await resolver.resolveTxt(domain);
        return txt.map((chunks) => ({ recordType: 'TXT', recordValue: chunks.join('') }));
      }
      case 'CNAME': {
        const cnames = await resolver.resolveCname(domain);
        return cnames.map((c) => ({ recordType: 'CNAME', recordValue: c }));
      }
      case 'SOA': {
        const soa = await resolver.resolveSoa(domain);
        return [
          {
            recordType: 'SOA',
            recordValue: `${soa.nsname} ${soa.hostmaster} ${soa.serial}`,
            ttl: soa.minttl,
          },
        ];
      }
      default:
        return [];
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENODATA / ENOTFOUND = legitimate empty — domain exists but no records of this type
    if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ESERVFAIL') {
      return [];
    }
    throw err;
  }
}

export async function resolveDnsRecords(domain: string): Promise<ResolveResult> {
  const records: DnsRecord[] = [];
  const failedTypes = new Set<string>();

  const tasks = RECORD_TYPES.map(async (rtype) => {
    try {
      const recs = await resolveType(domain, rtype);
      return { rtype, recs, error: null };
    } catch (err) {
      return { rtype, recs: [], error: err };
    }
  });

  const results = await Promise.allSettled(tasks);

  for (const settled of results) {
    if (settled.status === 'rejected') continue;
    const { rtype, recs, error } = settled.value;
    if (error) {
      failedTypes.add(rtype);
    } else {
      records.push(...recs);
    }
  }

  return { records, failedTypes };
}

// -------------------------------------------------------------------------
// Change detection
// -------------------------------------------------------------------------

function changeSeverity(recordType: string): Severity {
  if (recordType === 'NS') return 'critical';
  return 'warning' as Severity;
}

/**
 * Detect CDN provider from CNAME records for edge-IP-rotation suppression.
 */
function detectCdnProvider(records: DnsRecord[]): string | null {
  for (const rec of records) {
    if (rec.recordType !== 'CNAME') continue;
    const value = rec.recordValue.replace(/\.$/, '').toLowerCase();
    for (const [provider, patterns] of Object.entries(CDN_CNAME_PATTERNS)) {
      if (patterns.some((p) => value.endsWith(p))) return provider;
    }
  }
  return null;
}

export interface ChangeDetectionResult {
  changes: DnsChange[];
  suppressedAaaaa: boolean;
  hasDiff: boolean;
}

/**
 * Compare current DNS records against stored records. Detects added, removed,
 * and modified records. A/AAAA changes for CDN-proxied hosts are suppressed
 * when the new records still point to the same CDN provider (edge IP rotation).
 */
export function detectDnsChanges(
  currentRecords: DnsRecord[],
  storedRecords: DnsRecord[],
  failedTypes: Set<string>,
  options: { isProxied?: boolean; knownProvider?: string | null } = {},
): ChangeDetectionResult {
  const changes: DnsChange[] = [];
  let suppressedAaaaa = false;
  let hasDiff = false;

  // Group by record type
  const oldByType = new Map<string, Set<string>>();
  for (const r of storedRecords) {
    const set = oldByType.get(r.recordType) ?? new Set();
    set.add(r.recordValue);
    oldByType.set(r.recordType, set);
  }

  const newByType = new Map<string, Set<string>>();
  for (const r of currentRecords) {
    const set = newByType.get(r.recordType) ?? new Set();
    set.add(r.recordValue);
    newByType.set(r.recordType, set);
  }

  const allTypes = new Set([...oldByType.keys(), ...newByType.keys()]);

  for (const rtype of allTypes) {
    if (failedTypes.has(rtype)) continue;

    const oldValues = oldByType.get(rtype) ?? new Set<string>();
    const newValues = newByType.get(rtype) ?? new Set<string>();

    const added = [...newValues].filter((v) => !oldValues.has(v));
    const removed = [...oldValues].filter((v) => !newValues.has(v));

    if (added.length === 0 && removed.length === 0) continue;
    hasDiff = true;

    // CDN-aware suppression for A/AAAA on proxied hosts
    if ((rtype === 'A' || rtype === 'AAAA') && options.isProxied && options.knownProvider) {
      const newProvider = detectCdnProvider(currentRecords);
      if (newProvider && newProvider === options.knownProvider) {
        suppressedAaaaa = true;
        continue;
      }
      if (!newProvider) {
        // Cannot determine new provider; assume edge rotation for known proxied hosts
        suppressedAaaaa = true;
        continue;
      }
    }

    if (added.length > 0 && removed.length > 0) {
      changes.push({
        recordType: rtype,
        oldValue: [...removed].sort().join(', '),
        newValue: [...added].sort().join(', '),
        changeType: 'modified',
        severity: changeSeverity(rtype),
      });
    } else {
      for (const val of added) {
        changes.push({
          recordType: rtype,
          oldValue: null,
          newValue: val,
          changeType: 'added',
          severity: changeSeverity(rtype),
        });
      }
      for (const val of removed) {
        changes.push({
          recordType: rtype,
          oldValue: val,
          newValue: null,
          changeType: 'removed',
          severity: changeSeverity(rtype),
        });
      }
    }
  }

  return { changes, suppressedAaaaa, hasDiff };
}

// -------------------------------------------------------------------------
// Step runner
// -------------------------------------------------------------------------

export async function runDnsRecordsStep(
  domain: string,
  storedRecords: DnsRecord[],
  options: { isRoot: boolean; isProxied?: boolean; knownProvider?: string | null },
): Promise<StepResult> {
  const startedAt = new Date();

  if (!options.isRoot) {
    return { step: 'dns_records', status: 'skipped', startedAt, completedAt: new Date() };
  }

  try {
    const { records, failedTypes } = await resolveDnsRecords(domain);
    const changeResult = detectDnsChanges(records, storedRecords, failedTypes, {
      isProxied: options.isProxied,
      knownProvider: options.knownProvider,
    });

    return {
      step: 'dns_records',
      status: 'success',
      data: {
        records,
        failedTypes: [...failedTypes],
        changes: changeResult.changes,
        suppressedAaaaa: changeResult.suppressedAaaaa,
        hasDiff: changeResult.hasDiff,
        dnsRecordsCount: records.length,
        dnsChangesCount: changeResult.changes.length,
      },
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    return {
      step: 'dns_records',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    };
  }
}
