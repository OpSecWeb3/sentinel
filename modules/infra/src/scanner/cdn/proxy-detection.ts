import { getDb } from '@sentinel/db';
import {
  infraSnapshots, infraDnsRecords, infraHttpHeaderChecks,
  infraHosts, infraCdnProviderConfigs,
} from '@sentinel/db/schema/infra';
import { eq, desc, and } from '@sentinel/db';
import type { ProxyCheckResult } from './types.js';

const CDN_CNAME_PATTERNS: Record<string, string[]> = {
  cloudflare: ['.cloudflare.com', '.cloudflare-dns.com'],
  cloudfront: ['.cloudfront.net'],
  netlify: ['.netlify.app', '.netlify.com'],
  fastly: ['.fastly.net', '.fastlylb.net'],
};

const CDN_REVERSE_DNS_PATTERNS: Record<string, string[]> = {
  cloudfront: ['.cloudfront.net'],
};

const CDN_CLOUD_PROVIDERS: Record<string, string[]> = {
  cloudflare: ['cloudflare'],
  cloudfront: ['cloudfront', 'amazon'],
};

const CDN_HEADER_SIGNALS: Record<string, string[]> = {
  cloudflare: ['cloudflare'],
  cloudfront: ['cloudfront', 'amazons3'],
};

export function hostMatchesPattern(hostname: string, pattern: string | null): boolean {
  if (!pattern) return true; // catch-all
  const patterns = pattern.split(',').map((p) => p.trim().toLowerCase());
  const h = hostname.toLowerCase();
  return patterns.some((p) => {
    if (!p) return true;
    const regex = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$', 'i');
    return regex.test(h);
  });
}

export async function detectProxyStatus(hostId: string, orgId: string): Promise<{ isProxied: boolean; provider: string | null }> {
  const db = getDb();

  // Layer 1: cloud_provider from infra snapshot
  const [snap] = await db.select({ cloudProvider: infraSnapshots.cloudProvider })
    .from(infraSnapshots)
    .where(eq(infraSnapshots.hostId, hostId))
    .orderBy(desc(infraSnapshots.scannedAt))
    .limit(1);

  if (snap?.cloudProvider) {
    const providerLower = snap.cloudProvider.toLowerCase();
    for (const [cdn, patterns] of Object.entries(CDN_CLOUD_PROVIDERS)) {
      if (patterns.some((p) => providerLower.includes(p))) {
        return { isProxied: true, provider: cdn };
      }
    }
  }

  // Layer 2: CNAME records
  const cnames = await db.select({ recordValue: infraDnsRecords.recordValue })
    .from(infraDnsRecords)
    .where(and(eq(infraDnsRecords.hostId, hostId), eq(infraDnsRecords.recordType, 'CNAME')));

  for (const cname of cnames) {
    const val = (cname.recordValue ?? '').toLowerCase().replace(/\.$/, '');
    for (const [cdn, patterns] of Object.entries(CDN_CNAME_PATTERNS)) {
      if (patterns.some((p) => val.endsWith(p))) {
        return { isProxied: true, provider: cdn };
      }
    }
  }

  // Layer 3: Reverse DNS
  const rdns = await db.select({ reverseDnsName: infraSnapshots.reverseDnsName })
    .from(infraSnapshots)
    .where(eq(infraSnapshots.hostId, hostId))
    .orderBy(desc(infraSnapshots.scannedAt))
    .limit(4);

  for (const row of rdns) {
    if (!row.reverseDnsName) continue;
    const rdnsLower = row.reverseDnsName.toLowerCase().replace(/\.$/, '');
    for (const [cdn, patterns] of Object.entries(CDN_REVERSE_DNS_PATTERNS)) {
      if (patterns.some((p) => rdnsLower.endsWith(p))) {
        return { isProxied: true, provider: cdn };
      }
    }
  }

  // Layer 4: Server header
  const [headers] = await db.select({ serverHeaderValue: infraHttpHeaderChecks.serverHeaderValue })
    .from(infraHttpHeaderChecks)
    .where(eq(infraHttpHeaderChecks.hostId, hostId))
    .orderBy(desc(infraHttpHeaderChecks.checkedAt))
    .limit(1);

  if (headers?.serverHeaderValue) {
    const serverLower = headers.serverHeaderValue.toLowerCase();
    for (const [cdn, signals] of Object.entries(CDN_HEADER_SIGNALS)) {
      if (signals.some((s) => serverLower.includes(s))) {
        return { isProxied: true, provider: cdn };
      }
    }
  }

  return { isProxied: false, provider: null };
}

export async function checkProxyStatusBatch(hostIds: string[], orgId: string): Promise<ProxyCheckResult[]> {
  const db = getDb();

  // Fetch hostnames
  const hosts = await db.select({ id: infraHosts.id, hostname: infraHosts.hostname })
    .from(infraHosts)
    .where(eq(infraHosts.orgId, orgId));
  const hostMap = new Map(hosts.map((h) => [h.id, h.hostname]));

  // Fetch org CDN configs
  const cdnConfigs = await db.select({
    provider: infraCdnProviderConfigs.provider,
    hostPattern: infraCdnProviderConfigs.hostPattern,
  }).from(infraCdnProviderConfigs)
    .where(eq(infraCdnProviderConfigs.orgId, orgId));

  const results: ProxyCheckResult[] = [];

  for (const hostId of hostIds) {
    const hostname = hostMap.get(hostId) ?? '';
    const { isProxied, provider } = await detectProxyStatus(hostId, orgId);

    const hasProviderConfig = provider
      ? cdnConfigs.some((c) => c.provider === provider && hostMatchesPattern(hostname, c.hostPattern))
      : false;

    results.push({ hostId, hostname, isProxied, provider, detectionMethod: null, hasProviderConfig });
  }

  return results;
}
