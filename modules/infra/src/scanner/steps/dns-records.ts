/**
 * Step 1: DNS record resolution + change detection.
 *
 * Resolves A, AAAA, MX, NS, TXT, CNAME records using node:dns/promises.
 * Compares against previously stored records to detect changes.
 * CDN-aware suppression for A/AAAA changes when IPs belong to same provider.
 */
import dns from 'node:dns/promises';

import type { DnsChange, DnsRecord, Severity, StepResult } from '../types.js';

// SOA excluded: the serial increments on every zone change, causing constant
// false-positive "SOA modified" noise. SOA is queried separately for DNSSEC checks.
const RECORD_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME'] as const;

/** Well-known CDN CNAME suffixes used for edge-IP-rotation suppression. */
const CDN_CNAME_PATTERNS: Record<string, string[]> = {
  cloudflare: ['.cdn.cloudflare.net', '.cloudflare.net'],
  cloudfront: ['.cloudfront.net'],
  fastly: ['.fastly.net', '.fastlylb.net'],
  akamai: ['.akamaiedge.net', '.akamai.net', '.edgekey.net'],
};

/**
 * Known CDN IPv4 CIDR ranges for fallback provider detection when CNAME records
 * are absent (e.g. Cloudflare CNAME flattening at apex domains).
 * Format: [base address as uint32, prefix length]
 */
const CDN_IP_RANGES: Record<string, [number, number][]> = {
  cloudflare: [
    [0x68100000, 13],  // 104.16.0.0/13
    [0x68180000, 14],  // 104.24.0.0/14
    [0xac400000, 13],  // 172.64.0.0/13
    [0xa29e0000, 15],  // 162.158.0.0/15
    [0x8d654000, 18],  // 141.101.64.0/18
    [0x6ca2c000, 18],  // 108.162.192.0/18
    [0x6715f400, 22],  // 103.21.244.0/22
    [0x6716c800, 22],  // 103.22.200.0/22
    [0x671f0400, 22],  // 103.31.4.0/22
    [0x83004800, 22],  // 131.0.72.0/22
    [0xadf53000, 20],  // 173.245.48.0/20
    [0xbc726000, 20],  // 188.114.96.0/20
    [0xbe5df000, 20],  // 190.93.240.0/20
    [0xc5eaf000, 22],  // 197.234.240.0/22
    [0xc6298000, 17],  // 198.41.128.0/17
  ],
};

function ipv4ToUint32(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;
  return (
    ((parseInt(parts[0], 10) << 24) |
     (parseInt(parts[1], 10) << 16) |
     (parseInt(parts[2], 10) << 8)  |
      parseInt(parts[3], 10)) >>> 0
  );
}

function isInCidr(ip: string, base: number, prefixLen: number): boolean {
  try {
    const ipInt = ipv4ToUint32(ip);
    const mask = prefixLen === 0 ? 0 : ((~0 << (32 - prefixLen)) >>> 0);
    return (ipInt & mask) === (base & mask);
  } catch {
    return false;
  }
}

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
 * Detect CDN provider from current DNS records for edge-IP-rotation suppression.
 * Layer 1: CNAME suffix matching (definitive).
 * Layer 2: IPv4 range matching (fallback for CNAME-flattened apex domains where
 *           the resolver returns A records directly with no CNAME in the response).
 */
function detectCdnProvider(records: DnsRecord[]): string | null {
  // Layer 1: CNAME patterns
  for (const rec of records) {
    if (rec.recordType !== 'CNAME') continue;
    const value = rec.recordValue.replace(/\.$/, '').toLowerCase();
    for (const [provider, patterns] of Object.entries(CDN_CNAME_PATTERNS)) {
      if (patterns.some((p) => value.endsWith(p))) return provider;
    }
  }

  // Layer 2: A record IP ranges (handles CNAME flattening at apex)
  for (const rec of records) {
    if (rec.recordType !== 'A') continue;
    for (const [provider, ranges] of Object.entries(CDN_IP_RANGES)) {
      if (ranges.some(([base, prefix]) => isInCidr(rec.recordValue, base, prefix))) {
        return provider;
      }
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
    // Skip SOA regardless — serial increments on every zone change (noisy).
    // Any legacy SOA rows in the DB should not generate "removed" change records.
    if (rtype === 'SOA') continue;

    const oldValues = oldByType.get(rtype) ?? new Set<string>();
    const newValues = newByType.get(rtype) ?? new Set<string>();

    const added = [...newValues].filter((v) => !oldValues.has(v));
    const removed = [...oldValues].filter((v) => !newValues.has(v));

    if (added.length === 0 && removed.length === 0) continue;
    hasDiff = true;

    // CDN-aware suppression for A/AAAA on proxied hosts.
    // detectCdnProvider uses CNAME patterns then IPv4 range matching as fallback,
    // so !newProvider means the IPs are genuinely not in any known CDN range.
    if ((rtype === 'A' || rtype === 'AAAA') && options.isProxied && options.knownProvider) {
      const newProvider = detectCdnProvider(currentRecords);
      if (newProvider === options.knownProvider) {
        // Same CDN provider — suppress edge IP rotation noise.
        suppressedAaaaa = true;
        continue;
      }
      if (!newProvider) {
        // IPs not in any known CDN range and no CDN CNAME present.
        // This may indicate the host went unproxied, but could also be a provider
        // we don't have IP ranges for. Suppress conservatively; the proxy detection
        // system will update isProxied on the next full scan.
        suppressedAaaaa = true;
        continue;
      }
      // newProvider !== knownProvider: CDN provider changed — fall through to record it.
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
