/**
 * Step 2: DNS health check.
 *
 * Checks DNSSEC validation (DS/DNSKEY records), CAA record presence,
 * DMARC record parsing, and SPF record parsing + validation.
 */
import dns from 'node:dns/promises';

import type { DnsHealthData, StepResult } from '../types.js';

const DNSSEC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function resolveWithServers(domain: string, rtype: string): Promise<string[]> {
  const resolver = new dns.Resolver();
  resolver.setServers(DNSSEC_RESOLVERS);

  try {
    switch (rtype) {
      case 'TXT': {
        const records = await resolver.resolveTxt(domain);
        return records.map((chunks) => chunks.join(''));
      }
      case 'CNAME': {
        return await resolver.resolveCname(domain);
      }
      case 'A': {
        const addrs = await resolver.resolve4(domain);
        return addrs;
      }
      case 'AAAA': {
        const addrs = await resolver.resolve6(domain);
        return addrs;
      }
      case 'MX': {
        const entries = await resolver.resolveMx(domain);
        return entries.map((mx) => `${mx.priority} ${mx.exchange}`);
      }
      case 'NS': {
        return await resolver.resolveNs(domain);
      }
      case 'SOA': {
        const soa = await resolver.resolveSoa(domain);
        return [`${soa.nsname} ${soa.hostmaster}`];
      }
      case 'CAA': {
        const records = await resolver.resolveCaa(domain);
        return records.map((r) => {
          const flag = r.critical ? '1' : '0';
          // CaaRecord properties are: critical, issue?, issuewild?, iodef?, contactemail?, contactphone?
          const tag = r.issue != null ? 'issue'
            : r.issuewild != null ? 'issuewild'
            : r.iodef != null ? 'iodef'
            : r.contactemail != null ? 'contactemail'
            : r.contactphone != null ? 'contactphone'
            : 'issue';
          const value = r.issue ?? r.issuewild ?? r.iodef ?? r.contactemail ?? r.contactphone ?? '';
          return `${flag} ${tag} "${value}"`;
        });
      }
      default: {
        // No longer using resolveAny — it is unreliable on many resolvers
        return [];
      }
    }
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------------
// DNSSEC validation via DNS-over-HTTPS
// -------------------------------------------------------------------------

interface DnssecDetails {
  zone: string | null;
  adFlag: boolean;
  failureReason: string | null;
}

/**
 * Check DNSSEC validation using Cloudflare's DNS-over-HTTPS resolver.
 * Queries with the AD (Authenticated Data) flag which indicates the
 * resolver has validated the DNSSEC chain. This is far more reliable
 * than trying to query DS/DNSKEY records via Node's built-in resolver
 * which does not support the DO flag or DNSSEC wire-format responses.
 */
async function checkDnssecViaDoH(domain: string): Promise<boolean> {
  const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=A`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return false;
    const data = await res.json() as { AD?: boolean };
    return data.AD === true;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

async function checkDnssec(domain: string): Promise<{ enabled: boolean; details: DnssecDetails }> {
  const adFlag = await checkDnssecViaDoH(domain);
  const details: DnssecDetails = {
    zone: domain,
    adFlag,
    failureReason: adFlag ? null : 'DNSSEC not validated (AD flag not set by resolver)',
  };
  return { enabled: adFlag, details };
}

// -------------------------------------------------------------------------
// CAA records
// -------------------------------------------------------------------------

async function checkCaa(domain: string): Promise<string[]> {
  const resolver = new dns.Resolver();
  resolver.setServers(DNSSEC_RESOLVERS);
  try {
    const records = await resolver.resolveCaa(domain);
    return records.map((r) => {
      const flag = r.critical ? '1' : '0';
      const tag = r.issue != null ? 'issue'
        : r.issuewild != null ? 'issuewild'
        : r.iodef != null ? 'iodef'
        : r.contactemail != null ? 'contactemail'
        : r.contactphone != null ? 'contactphone'
        : 'issue';
      const value = r.issue ?? r.issuewild ?? r.iodef ?? r.contactemail ?? r.contactphone ?? '';
      return `${flag} ${tag} "${value}"`;
    });
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------------
// DMARC parsing
// -------------------------------------------------------------------------

function parseDmarc(
  txtRecords: string[],
): { record: string | null; policy: string | null } {
  for (const txt of txtRecords) {
    const cleaned = txt.replace(/^"|"$/g, '');
    if (!cleaned.startsWith('v=DMARC1')) continue;

    let policy: string | null = null;
    for (const part of cleaned.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('p=')) {
        policy = trimmed.slice(2).trim().toLowerCase();
      }
    }
    return { record: cleaned, policy };
  }
  return { record: null, policy: null };
}

// -------------------------------------------------------------------------
// SPF parsing and validation
// -------------------------------------------------------------------------

interface SpfResult {
  record: string | null;
  valid: boolean;
  tooPermissive: boolean;
  tooManyLookups: boolean;
  lookupCount: number;
  missingTerminator: boolean;
}

function parseSpf(txtRecords: string[]): SpfResult {
  const result: SpfResult = {
    record: null,
    valid: false,
    tooPermissive: false,
    tooManyLookups: false,
    lookupCount: 0,
    missingTerminator: false,
  };

  for (const txt of txtRecords) {
    const cleaned = txt.replace(/^"|"$/g, '');
    if (!cleaned.startsWith('v=spf1')) continue;

    result.record = cleaned;

    // Count DNS-lookup mechanisms (RFC 7208 limit is 10)
    const dnsMechanisms = ['include:', 'a:', 'a ', 'mx:', 'mx ', 'redirect=', 'exists:'];
    const parts = cleaned.split(/\s+/);
    let lookupCount = 0;

    for (const part of parts) {
      const normalized = part.toLowerCase().replace(/^[+\-~?]/, '');
      if (dnsMechanisms.some((m) => normalized.startsWith(m))) {
        lookupCount++;
      } else if (normalized === 'a' || normalized === 'mx') {
        lookupCount++;
      }
    }

    const hasTerminator =
      cleaned.includes('-all') ||
      cleaned.includes('~all') ||
      cleaned.includes('+all') ||
      cleaned.includes('?all') ||
      cleaned.includes('redirect=');

    result.lookupCount = lookupCount;
    result.tooPermissive = cleaned.includes('+all');
    result.tooManyLookups = lookupCount > 10;
    result.missingTerminator = !hasTerminator;
    result.valid = hasTerminator && !result.tooPermissive && !result.tooManyLookups;

    break;
  }

  return result;
}

// -------------------------------------------------------------------------
// Dangling CNAMEs
// -------------------------------------------------------------------------

async function checkDanglingCnames(domain: string): Promise<string[]> {
  const dangling: string[] = [];
  const resolver = new dns.Resolver();
  resolver.setServers(DNSSEC_RESOLVERS);

  try {
    const cnames = await resolver.resolveCname(domain);
    for (const target of cnames) {
      const cleaned = target.replace(/\.$/, '');
      try {
        await resolver.resolve4(cleaned);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTFOUND') {
          dangling.push(cleaned);
        }
      }
    }
  } catch {
    // No CNAME records or resolution failed
  }

  return dangling;
}

// -------------------------------------------------------------------------
// Step runner
// -------------------------------------------------------------------------

export async function checkDnsHealth(domain: string): Promise<DnsHealthData> {
  // Run all checks in parallel
  const [dnssecResult, caaRecords, dmarcTxt, spfTxt, danglingCnames] = await Promise.allSettled([
    checkDnssec(domain),
    checkCaa(domain),
    resolveWithServers(`_dmarc.${domain}`, 'TXT'),
    resolveWithServers(domain, 'TXT'),
    checkDanglingCnames(domain),
  ]);

  const dnssec =
    dnssecResult.status === 'fulfilled'
      ? dnssecResult.value
      : { enabled: false, details: { zone: null, hasDs: false, hasDnskey: false, failureReason: 'Check failed' } };

  const caa = caaRecords.status === 'fulfilled' ? caaRecords.value : [];
  const dmarcTexts = dmarcTxt.status === 'fulfilled' ? dmarcTxt.value : [];
  const spfTexts = spfTxt.status === 'fulfilled' ? spfTxt.value : [];
  const dangling = danglingCnames.status === 'fulfilled' ? danglingCnames.value : [];

  const dmarc = parseDmarc(dmarcTexts);
  const spf = parseSpf(spfTexts);

  return {
    dnssecEnabled: dnssec.enabled,
    dnssecDetails: JSON.stringify(dnssec.details),
    caaRecords: JSON.stringify(caa),
    dmarcRecord: dmarc.record,
    dmarcPolicy: dmarc.policy,
    spfRecord: spf.record,
    spfValid: spf.valid,
    spfTooPermissive: spf.tooPermissive,
    spfTooManyLookups: spf.tooManyLookups,
    spfLookupCount: spf.lookupCount,
    spfMissingTerminator: spf.missingTerminator,
    danglingCnames: JSON.stringify(dangling),
  };
}

export async function runDnsHealthStep(domain: string): Promise<StepResult> {
  const startedAt = new Date();

  try {
    const data = await checkDnsHealth(domain);
    return {
      step: 'dns_health',
      status: 'success',
      data: {
        ...data,
        dnssec: data.dnssecEnabled,
        hasCaa: JSON.parse(data.caaRecords).length > 0,
        hasDmarc: data.dmarcRecord !== null,
        hasSpf: data.spfRecord !== null,
      },
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    return {
      step: 'dns_health',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    };
  }
}
