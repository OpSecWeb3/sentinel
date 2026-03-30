import type { Redis } from 'ioredis';

import { getDb } from '@sentinel/db';
import {
  infraSnapshots, infraDnsRecords, infraHttpHeaderChecks,
  infraHosts, infraCdnProviderConfigs,
} from '@sentinel/db/schema/infra';
import { eq, desc, and } from '@sentinel/db';
import type { ProxyCheckResult } from './types.js';

const PROXY_CACHE_KEY_PREFIX = 'cache:proxy_status:';
const PROXY_CACHE_TTL_SECONDS = 86_400; // 24 hours

const CDN_CNAME_PATTERNS: Record<string, string[]> = {
  cloudflare: ['.cloudflare.com', '.cloudflare-dns.com', '.cdn.cloudflare.net', '.cloudflare.net'],
  cloudfront: ['.cloudfront.net'],
  netlify: ['.netlify.app', '.netlify.com'],
  fastly: ['.fastly.net', '.fastlylb.net'],
  akamai: ['.akamaiedge.net', '.akamai.net', '.edgekey.net'],
  s3: ['.amazonaws.com'],
};

const CDN_REVERSE_DNS_PATTERNS: Record<string, string[]> = {
  cloudfront: ['.cloudfront.net'],
  akamai: ['.akamaiedge.net', '.deploy.static.akamaitechnologies.com'],
};

const CDN_CLOUD_PROVIDERS: Record<string, string[]> = {
  cloudflare: ['cloudflare'],
  cloudfront: ['cloudfront', 'amazon'],
  s3: ['s3', 'amazonaws'],
};

const CDN_HEADER_SIGNALS: Record<string, string[]> = {
  cloudflare: ['cloudflare'],
  cloudfront: ['cloudfront', 'amazons3'],
  netlify: ['netlify'],
  akamai: ['akamaighost', 'akamai'],
};

export function hostMatchesPattern(hostname: string, pattern: string | null): boolean {
  if (!pattern || pattern === '*') return true; // catch-all
  const patterns = pattern.split(',').map((p) => p.trim().toLowerCase());
  const h = hostname.toLowerCase();
  return patterns.some((p) => {
    if (!p) return true;
    const regex = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$', 'i');
    return regex.test(h);
  });
}

export async function detectProxyStatus(
  hostId: string,
  orgId: string,
  redis?: Redis,
): Promise<{ isProxied: boolean; provider: string | null }> {
  // Check Redis cache first
  if (redis) {
    try {
      const cached = await redis.get(`${PROXY_CACHE_KEY_PREFIX}${hostId}`);
      if (cached) {
        return JSON.parse(cached) as { isProxied: boolean; provider: string | null };
      }
    } catch {
      // Redis failure is non-fatal — fall through to DB detection
    }
  }

  const result = await detectProxyStatusFromDb(hostId);

  // Cache the result (positive or negative) in Redis
  if (redis) {
    try {
      await redis.set(
        `${PROXY_CACHE_KEY_PREFIX}${hostId}`,
        JSON.stringify(result),
        'EX',
        PROXY_CACHE_TTL_SECONDS,
      );
    } catch {
      // Redis failure is non-fatal
    }
  }

  return result;
}

/**
 * Invalidate the cached proxy status for a host.
 * Call after an infrastructure scan completes to ensure fresh data on next check.
 */
export async function invalidateProxyStatusCache(hostId: string, redis: Redis): Promise<void> {
  try {
    await redis.del(`${PROXY_CACHE_KEY_PREFIX}${hostId}`);
  } catch {
    // Redis failure is non-fatal
  }
}

/** Internal: run the 4-layer DB detection without caching. */
async function detectProxyStatusFromDb(hostId: string): Promise<{ isProxied: boolean; provider: string | null }> {
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

export async function checkProxyStatusBatch(hostIds: string[], orgId: string, redis?: Redis): Promise<ProxyCheckResult[]> {
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
    const { isProxied, provider } = await detectProxyStatus(hostId, orgId, redis);

    const hasProviderConfig = provider
      ? cdnConfigs.some((c) => c.provider === provider && hostMatchesPattern(hostname, c.hostPattern))
      : false;

    results.push({ hostId, hostname, isProxied, provider, detectionMethod: null, hasProviderConfig });
  }

  return results;
}
