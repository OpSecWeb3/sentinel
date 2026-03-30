/**
 * Step 7: Infrastructure scan.
 *
 * DNS lookup for IP addresses, reverse DNS, basic cloud provider detection,
 * and simple port scan on common ports (80, 443, 8080, 8443) using net.connect.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

import type { Redis } from 'ioredis';

import type { InfraResult, PortResult, StepResult } from '../types.js';
import { isPrivateIp } from '../orchestrator.js';
import { detectCloudProviderByIp, hasCloudRanges, loadCloudRanges } from './cloud-ranges.js';

const PORT_SCAN_TIMEOUT_MS = 3_000;

/** All ports that are referenced in scoring, plus common web ports. */
const SCAN_PORTS = [
  { port: 22, service: 'SSH' },
  { port: 80, service: 'HTTP' },
  { port: 443, service: 'HTTPS' },
  { port: 3306, service: 'MySQL' },
  { port: 3389, service: 'RDP' },
  { port: 5432, service: 'PostgreSQL' },
  { port: 6379, service: 'Redis' },
  { port: 8080, service: 'HTTP-Alt' },
  { port: 8443, service: 'HTTPS-Alt' },
  { port: 9200, service: 'Elasticsearch' },
  { port: 27017, service: 'MongoDB' },
] as const;

/** Well-known reverse-DNS patterns for cloud provider detection. */
const CLOUD_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /\.cloudflare\.com$/i, provider: 'Cloudflare' },
  { pattern: /\.cloudfront\.net$/i, provider: 'CloudFront' },
  { pattern: /\.amazonaws\.com$/i, provider: 'AWS' },
  { pattern: /\.compute\.googleapis\.com$/i, provider: 'GCP' },
  { pattern: /\.googleusercontent\.com$/i, provider: 'GCP' },
  { pattern: /\.azure\.com$/i, provider: 'Azure' },
  { pattern: /\.azurewebsites\.net$/i, provider: 'Azure' },
  { pattern: /\.akamaiedge\.net$/i, provider: 'Akamai' },
  { pattern: /\.fastly\.net$/i, provider: 'Fastly' },
  { pattern: /\.digitaloceanspaces\.com$/i, provider: 'DigitalOcean' },
  { pattern: /\.vultr\.com$/i, provider: 'Vultr' },
  { pattern: /\.linode\.com$/i, provider: 'Linode' },
  { pattern: /\.hetzner\.com$/i, provider: 'Hetzner' },
  { pattern: /\.ovh\.(net|com)$/i, provider: 'OVH' },
];

// -------------------------------------------------------------------------
// IP resolution
// -------------------------------------------------------------------------

interface ResolvedIp {
  ip: string;
  version: 4 | 6;
}

async function resolveIps(domain: string): Promise<ResolvedIp[]> {
  const ips: ResolvedIp[] = [];

  try {
    const v4 = await dns.resolve4(domain);
    for (const ip of v4) ips.push({ ip, version: 4 });
  } catch {
    // No A records
  }

  try {
    const v6 = await dns.resolve6(domain);
    for (const ip of v6) ips.push({ ip, version: 6 });
  } catch {
    // No AAAA records
  }

  return ips;
}

// -------------------------------------------------------------------------
// Reverse DNS
// -------------------------------------------------------------------------

async function reverseLookup(ip: string): Promise<string | null> {
  try {
    const hostnames = await dns.reverse(ip);
    return hostnames[0] ?? null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------
// Cloud provider detection
// -------------------------------------------------------------------------

/**
 * Detect cloud provider for an IP address.
 *
 * Layer 1: Match IP against published cloud CIDR ranges (AWS, GCP, Cloudflare).
 * Layer 2: Match reverse DNS hostname against well-known patterns.
 *
 * IP range matching is the primary signal — many CDN IPs lack rDNS entries
 * pointing back to the provider domain.
 */
function detectCloudProvider(ip: string, reverseDns: string | null): string | null {
  // Layer 1: IP range match (most reliable)
  if (hasCloudRanges()) {
    const provider = detectCloudProviderByIp(ip);
    if (provider) return provider;
  }

  // Layer 2: Reverse DNS pattern match (fallback)
  if (!reverseDns) return null;

  for (const { pattern, provider } of CLOUD_PATTERNS) {
    if (pattern.test(reverseDns)) return provider;
  }

  return null;
}

// -------------------------------------------------------------------------
// Port scanning
// -------------------------------------------------------------------------

function scanPort(ip: string, port: number): Promise<boolean> {
  // SSRF protection: refuse to scan private/internal IPs
  if (isPrivateIp(ip)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(PORT_SCAN_TIMEOUT_MS);

    socket.on('connect', () => {
      cleanup();
      resolve(true);
    });

    socket.on('error', () => {
      cleanup();
      resolve(false);
    });

    socket.on('timeout', () => {
      cleanup();
      resolve(false);
    });

    socket.connect(port, ip);
  });
}

async function scanPorts(ip: string): Promise<PortResult[]> {
  const results = await Promise.allSettled(
    SCAN_PORTS.map(async ({ port, service }) => {
      const open = await scanPort(ip, port);
      return { port, open, service } satisfies PortResult;
    }),
  );

  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
}

// -------------------------------------------------------------------------
// Geo IP / ASN lookup (cached 7 days, rate-limited 40 req/min)
// -------------------------------------------------------------------------

interface GeoIpData {
  country: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  asn: string | null;
  asnOrg: string | null;
}

const GEO_CACHE_PREFIX = 'cache:geoip:';
const GEO_CACHE_TTL = 604_800; // 7 days in seconds

// ip-api.com free tier: 45 requests/minute. We use 40 to leave headroom.
const IPAPI_RATE_KEY = 'sentinel:ipapi:ratelimit';
const IPAPI_RATE_WINDOW_MS = 60_000;
const IPAPI_RATE_MAX = 40;

const SLIDING_WINDOW_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local maxRequests = tonumber(ARGV[3])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
  local count = redis.call('ZCARD', key)
  if count >= maxRequests then
    return 0
  end
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('EXPIRE', key, math.ceil(windowMs / 1000))
  return 1
`;

async function acquireIpApiSlot(redis: Redis): Promise<boolean> {
  const result = await redis.eval(
    SLIDING_WINDOW_LUA, 1, IPAPI_RATE_KEY, Date.now(), IPAPI_RATE_WINDOW_MS, IPAPI_RATE_MAX,
  ) as number;
  return result === 1;
}

async function lookupGeoIp(ip: string, redis?: Redis): Promise<GeoIpData> {
  const empty: GeoIpData = { country: null, city: null, lat: null, lon: null, asn: null, asnOrg: null };

  // Check Redis cache
  if (redis) {
    try {
      const cached = await redis.get(`${GEO_CACHE_PREFIX}${ip}`);
      if (cached) return JSON.parse(cached) as GeoIpData;
    } catch { /* cache miss */ }
  }

  // Rate limit check
  if (redis) {
    try {
      const allowed = await acquireIpApiSlot(redis);
      if (!allowed) return empty;
    } catch { /* proceed without rate limiting */ }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=country,city,lat,lon,as,org,status`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return empty;
    const data = await res.json() as Record<string, unknown>;
    if (data.status !== 'success') return empty;
    // Parse ASN from "as" field (e.g. "AS13335 Cloudflare, Inc.")
    const asField = (data.as as string) ?? '';
    const asnMatch = asField.match(/^(AS\d+)/);
    const result: GeoIpData = {
      country: (data.country as string) ?? null,
      city: (data.city as string) ?? null,
      lat: typeof data.lat === 'number' ? data.lat : null,
      lon: typeof data.lon === 'number' ? data.lon : null,
      asn: asnMatch ? asnMatch[1] : null,
      asnOrg: (data.org as string) ?? null,
    };

    // Cache successful results
    if (redis && result.country) {
      try { await redis.set(`${GEO_CACHE_PREFIX}${ip}`, JSON.stringify(result), 'EX', GEO_CACHE_TTL); } catch { /* non-fatal */ }
    }

    return result;
  } catch {
    return empty;
  }
}

// -------------------------------------------------------------------------
// Full infrastructure scan
// -------------------------------------------------------------------------

export async function scanInfrastructure(domain: string, options?: { redis?: Redis }): Promise<InfraResult[]> {
  // Ensure cloud IP ranges are loaded before scanning
  await loadCloudRanges(options?.redis);

  const allIps = await resolveIps(domain);
  // Filter out private IPs to prevent SSRF / DNS rebinding
  const ips = allIps.filter(({ ip }) => !isPrivateIp(ip));
  if (ips.length === 0) return [];

  const results = await Promise.allSettled(
    ips.map(async ({ ip, version }): Promise<InfraResult> => {
      const [reverseDns, ports, geo] = await Promise.all([
        reverseLookup(ip),
        scanPorts(ip),
        lookupGeoIp(ip, options?.redis),
      ]);

      const cloudProvider = detectCloudProvider(ip, reverseDns);

      return {
        ip,
        version,
        reverseDns,
        cloudProvider,
        ports,
        geoCountry: geo.country,
        geoCity: geo.city,
        geoLat: geo.lat,
        geoLon: geo.lon,
        asn: geo.asn,
        asnOrg: geo.asnOrg,
      };
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<InfraResult> => r.status === 'fulfilled')
    .map((r) => r.value);
}

// -------------------------------------------------------------------------
// Step runner
// -------------------------------------------------------------------------

export async function runInfrastructureStep(domain: string, options?: { redis?: Redis }): Promise<StepResult> {
  const startedAt = new Date();

  try {
    const infraResults = await scanInfrastructure(domain, options);

    return {
      step: 'infrastructure',
      status: 'success',
      data: {
        results: infraResults,
        infraIps: infraResults.length,
      },
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    return {
      step: 'infrastructure',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    };
  }
}
