/**
 * CDN origin IP monitoring.
 *
 * Checks origin IPs behind CDN proxies (Cloudflare, CloudFront) using
 * provider APIs. Detects changes that would be invisible to public DNS
 * monitoring since proxied hosts resolve to CDN edge IPs, not origins.
 *
 * Called during probe runs for hosts whose org has a valid CDN provider
 * config. The caller is responsible for the proxy status check so
 * non-proxied hosts never enter this path.
 */
import type { Redis } from 'ioredis';

import { getDb } from '@sentinel/db';
import {
  infraCdnProviderConfigs,
  infraCdnOriginRecords,
} from '@sentinel/db/schema/infra';
import { eq, and } from '@sentinel/db';

import { logger as rootLogger } from '@sentinel/shared/logger';
import { decrypt } from '@sentinel/shared/crypto';

import { getOriginIps as cfGetOriginIps } from './cloudflare.js';
import { getOriginDomains as cfdGetOriginDomains } from './cloudfront.js';
import { hostMatchesPattern } from './proxy-detection.js';

const log = rootLogger.child({ component: 'cdn-origin-check' });

/** Maps provider API record types to our ORIGIN_ prefixed types. */
const ORIGIN_TYPE_MAP: Record<string, string> = {
  A: 'ORIGIN_A',
  AAAA: 'ORIGIN_AAAA',
  CNAME: 'ORIGIN_CNAME',
};

// ---------------------------------------------------------------------------
// Config lookup
// ---------------------------------------------------------------------------

interface CdnConfig {
  id: string;
  provider: string;
  hostPattern: string;
  encryptedCredentials: string;
}

/**
 * Find the best-matching valid CDN provider config for a host.
 *
 * Returns the most specific match by pattern (exact > glob > catch-all),
 * or null if no valid config matches.
 */
export async function getCdnProviderConfig(
  orgId: string,
  hostname: string,
): Promise<CdnConfig | null> {
  const db = getDb();

  const configs = await db
    .select({
      id: infraCdnProviderConfigs.id,
      provider: infraCdnProviderConfigs.provider,
      hostPattern: infraCdnProviderConfigs.hostPattern,
      encryptedCredentials: infraCdnProviderConfigs.encryptedCredentials,
    })
    .from(infraCdnProviderConfigs)
    .where(
      and(
        eq(infraCdnProviderConfigs.orgId, orgId),
        eq(infraCdnProviderConfigs.isValid, true),
      ),
    );

  let best: CdnConfig | null = null;
  let bestScore = -1;

  for (const config of configs) {
    if (!hostMatchesPattern(hostname, config.hostPattern)) continue;

    // Score: exact hostname (2) > glob (1) > catch-all (0)
    let score = 0;
    if (!config.hostPattern || config.hostPattern === '*') {
      score = 0;
    } else if (config.hostPattern.includes('*') || config.hostPattern.includes('?')) {
      score = 1;
    } else {
      score = 2;
    }

    if (score > bestScore) {
      best = config;
      bestScore = score;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Origin fetching per provider
// ---------------------------------------------------------------------------

type OriginMap = Record<string, string[]>;

async function fetchOrigins(
  provider: string,
  credentials: Record<string, string>,
  domain: string,
  redis?: Redis,
): Promise<OriginMap> {
  if (provider === 'cloudflare') {
    return cfGetOriginIps(credentials.apiToken, domain, { redis });
  }

  if (provider === 'cloudfront') {
    const origins = await cfdGetOriginDomains(
      credentials.accessKeyId,
      credentials.secretAccessKey,
      credentials.region,
      domain,
      { redis },
    );
    // CloudFront origins are hostnames (e.g. ELB DNS), not IPs
    return origins.length > 0 ? { CNAME: origins } : {};
  }

  log.warn({ provider }, 'no origin fetcher for provider');
  return {};
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export interface OriginChange {
  recordType: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: 'added' | 'removed' | 'modified';
  severity: 'critical';
}

/**
 * Check for CDN origin changes for a proxied host.
 *
 * 1. Decrypts CDN credentials from the config.
 * 2. Calls the provider API to fetch current origin IPs/hostnames.
 * 3. Compares against stored `infraCdnOriginRecords`.
 * 4. First probe = establishes baseline (returns empty).
 * 5. Subsequent probes = returns list of changes (critical severity).
 * 6. Updates stored records to reflect current state.
 */
export async function checkOriginChanges(
  hostId: string,
  domain: string,
  config: CdnConfig,
  options?: { redis?: Redis },
): Promise<OriginChange[]> {
  // Decrypt credentials
  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(decrypt(config.encryptedCredentials));
  } catch (err) {
    log.error({ err, hostId, provider: config.provider }, 'failed to decrypt CDN credentials');
    return [];
  }

  // Fetch current origins from provider API
  let currentOrigins: OriginMap;
  try {
    currentOrigins = await fetchOrigins(config.provider, credentials, domain, options?.redis);
  } catch (err) {
    log.error({ err, hostId, provider: config.provider }, 'failed to fetch CDN origins');
    return [];
  }

  if (Object.keys(currentOrigins).length === 0) return [];

  const db = getDb();

  // Load stored origin records
  const storedRecords = await db
    .select({
      recordType: infraCdnOriginRecords.recordType,
      recordValue: infraCdnOriginRecords.recordValue,
    })
    .from(infraCdnOriginRecords)
    .where(eq(infraCdnOriginRecords.hostId, hostId));

  // First probe — establish baseline, no changes to report
  if (storedRecords.length === 0) {
    const now = new Date();
    const rows = [];
    for (const [rtype, values] of Object.entries(currentOrigins)) {
      const originType = ORIGIN_TYPE_MAP[rtype] ?? `ORIGIN_${rtype}`;
      for (const value of values) {
        rows.push({
          hostId,
          provider: config.provider,
          recordType: originType,
          recordValue: value,
          observedAt: now,
        });
      }
    }
    if (rows.length > 0) {
      await db.insert(infraCdnOriginRecords).values(rows);
    }
    log.info({ hostId, provider: config.provider, origins: currentOrigins }, 'established CDN origin baseline');
    return [];
  }

  // Group stored records by provider type (ORIGIN_A -> A)
  const storedByType = new Map<string, Set<string>>();
  for (const rec of storedRecords) {
    const providerType = rec.recordType.replace('ORIGIN_', '');
    if (!storedByType.has(providerType)) storedByType.set(providerType, new Set());
    storedByType.get(providerType)!.add(rec.recordValue);
  }

  // Compare
  const changes: OriginChange[] = [];
  const allTypes = new Set([...storedByType.keys(), ...Object.keys(currentOrigins)]);

  for (const rtype of allTypes) {
    const currentSet = new Set(currentOrigins[rtype] ?? []);
    const storedSet = storedByType.get(rtype) ?? new Set();

    const added = [...currentSet].filter((v) => !storedSet.has(v));
    const removed = [...storedSet].filter((v) => !currentSet.has(v));

    if (added.length === 0 && removed.length === 0) continue;

    const originType = ORIGIN_TYPE_MAP[rtype] ?? `ORIGIN_${rtype}`;

    if (added.length > 0 && removed.length > 0) {
      changes.push({
        recordType: originType,
        oldValue: [...removed].sort().join(', '),
        newValue: [...added].sort().join(', '),
        changeType: 'modified',
        severity: 'critical',
      });
    } else {
      for (const val of added) {
        changes.push({ recordType: originType, oldValue: null, newValue: val, changeType: 'added', severity: 'critical' });
      }
      for (const val of removed) {
        changes.push({ recordType: originType, oldValue: val, newValue: null, changeType: 'removed', severity: 'critical' });
      }
    }
  }

  // Update stored records if changed
  if (changes.length > 0) {
    const now = new Date();
    await db.delete(infraCdnOriginRecords).where(eq(infraCdnOriginRecords.hostId, hostId));

    const rows = [];
    for (const [rtype, values] of Object.entries(currentOrigins)) {
      const originType = ORIGIN_TYPE_MAP[rtype] ?? `ORIGIN_${rtype}`;
      for (const value of values) {
        rows.push({
          hostId,
          provider: config.provider,
          recordType: originType,
          recordValue: value,
          observedAt: now,
        });
      }
    }
    if (rows.length > 0) {
      await db.insert(infraCdnOriginRecords).values(rows);
    }

    log.warn({ hostId, provider: config.provider, changes }, 'CDN origin change detected');
  }

  return changes;
}
