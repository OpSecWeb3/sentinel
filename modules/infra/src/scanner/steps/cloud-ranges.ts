/**
 * Cloud provider IP range fetching and caching.
 *
 * Downloads published CIDR ranges from AWS, GCP, and Cloudflare, caches them
 * in Redis (24h TTL) with an in-memory fallback, and exposes a
 * `detectCloudProviderByIp()` function for infrastructure scanning.
 *
 * Mirrors the approach from Scout's `infra_service.load_cloud_ranges()`.
 */
import type { Redis } from 'ioredis';

import { logger as rootLogger } from '@sentinel/shared/logger';

const log = rootLogger.child({ component: 'infra-cloud-ranges' });

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_KEY = 'cache:cloud_ranges';
const CACHE_TTL_SECONDS = 86_400; // 24 hours

// ---------------------------------------------------------------------------
// CIDR matching helpers
// ---------------------------------------------------------------------------

/** Parse a CIDR string into a base address (BigInt) and prefix length. */
function parseCidr(cidr: string): { base: bigint; prefixLen: number; bits: 32 | 128 } | null {
  const [addr, lenStr] = cidr.split('/');
  if (!addr || !lenStr) return null;
  const prefixLen = parseInt(lenStr, 10);

  if (addr.includes(':')) {
    // IPv6
    const expanded = expandIpv6(addr);
    if (!expanded) return null;
    return { base: ipv6ToBigInt(expanded), prefixLen, bits: 128 };
  }

  // IPv4
  const n = ipv4ToUint32(addr);
  if (n === null) return null;
  return { base: BigInt(n) & ((0xFFFF_FFFFn >> BigInt(32 - prefixLen)) << BigInt(32 - prefixLen)), prefixLen, bits: 32 };
}

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (Number.isNaN(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function expandIpv6(ip: string): string | null {
  // Handle :: expansion
  let halves = ip.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;

  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.map(g => g.padStart(4, '0')).join(':');
}

function ipv6ToBigInt(expanded: string): bigint {
  const groups = expanded.split(':');
  let n = 0n;
  for (const g of groups) {
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

// ---------------------------------------------------------------------------
// Parsed range type
// ---------------------------------------------------------------------------

interface ParsedRange {
  base: bigint;
  prefixLen: number;
  bits: 32 | 128;
  mask: bigint;
}

function buildMask(bits: 32 | 128, prefixLen: number): bigint {
  const totalBits = BigInt(bits);
  const shift = totalBits - BigInt(prefixLen);
  // All 1s in the prefix, 0s in the host part
  return ((1n << totalBits) - 1n) >> shift << shift;
}

function toParsedRange(cidr: string): ParsedRange | null {
  const parsed = parseCidr(cidr);
  if (!parsed) return null;
  const mask = buildMask(parsed.bits, parsed.prefixLen);
  return { base: parsed.base & mask, prefixLen: parsed.prefixLen, bits: parsed.bits, mask };
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cachedRanges: Map<string, ParsedRange[]> = new Map();
let cacheLoadedAt = 0;

/** Check if in-memory cache is fresh (< 24h old). */
function isCacheFresh(): boolean {
  return cachedRanges.size > 0 && Date.now() - cacheLoadedAt < CACHE_TTL_SECONDS * 1000;
}

// ---------------------------------------------------------------------------
// Fetch from APIs
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface RawRanges {
  [provider: string]: string[];
}

async function fetchCloudRangesFromApis(): Promise<RawRanges> {
  const ranges: RawRanges = {};

  // --- AWS ---
  try {
    const res = await fetchWithTimeout('https://ip-ranges.amazonaws.com/ip-ranges.json');
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      const cidrs: string[] = [];
      for (const prefix of (data.prefixes as Array<Record<string, string>>) ?? []) {
        if (prefix.ip_prefix) cidrs.push(prefix.ip_prefix);
      }
      for (const prefix of (data.ipv6_prefixes as Array<Record<string, string>>) ?? []) {
        if (prefix.ipv6_prefix) cidrs.push(prefix.ipv6_prefix);
      }
      ranges.AWS = cidrs;
      log.info({ count: cidrs.length }, 'loaded AWS IP ranges');
    }
  } catch (err) {
    log.warn({ err }, 'failed to load AWS IP ranges');
  }

  // --- GCP ---
  try {
    const res = await fetchWithTimeout('https://www.gstatic.com/ipranges/cloud.json');
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      const cidrs: string[] = [];
      for (const prefix of (data.prefixes as Array<Record<string, string>>) ?? []) {
        if (prefix.ipv4Prefix) cidrs.push(prefix.ipv4Prefix);
        if (prefix.ipv6Prefix) cidrs.push(prefix.ipv6Prefix);
      }
      ranges.GCP = cidrs;
      log.info({ count: cidrs.length }, 'loaded GCP IP ranges');
    }
  } catch (err) {
    log.warn({ err }, 'failed to load GCP IP ranges');
  }

  // --- Cloudflare ---
  try {
    const cidrs: string[] = [];
    for (const url of [
      'https://www.cloudflare.com/ips-v4',
      'https://www.cloudflare.com/ips-v6',
    ]) {
      const res = await fetchWithTimeout(url);
      if (res.ok) {
        const text = await res.text();
        for (const line of text.trim().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) cidrs.push(trimmed);
        }
      }
    }
    ranges.Cloudflare = cidrs;
    log.info({ count: cidrs.length }, 'loaded Cloudflare IP ranges');
  } catch (err) {
    log.warn({ err }, 'failed to load Cloudflare IP ranges');
  }

  return ranges;
}

// ---------------------------------------------------------------------------
// Load & persist
// ---------------------------------------------------------------------------

function parseRawRanges(raw: RawRanges): Map<string, ParsedRange[]> {
  const result = new Map<string, ParsedRange[]>();
  for (const [provider, cidrs] of Object.entries(raw)) {
    const parsed: ParsedRange[] = [];
    for (const cidr of cidrs) {
      const r = toParsedRange(cidr);
      if (r) parsed.push(r);
    }
    if (parsed.length > 0) result.set(provider, parsed);
  }
  return result;
}

/**
 * Load cloud IP ranges — tries Redis cache first, then fetches from APIs.
 * Populates the in-memory cache and persists to Redis for sharing across workers.
 */
export async function loadCloudRanges(redis?: Redis): Promise<void> {
  // Fast path: in-memory cache is still fresh
  if (isCacheFresh()) return;

  // Try Redis cache
  if (redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        const raw = JSON.parse(cached) as RawRanges;
        cachedRanges = parseRawRanges(raw);
        cacheLoadedAt = Date.now();
        log.info(
          { providers: Object.fromEntries([...cachedRanges.entries()].map(([k, v]) => [k, v.length])) },
          'loaded cloud ranges from Redis cache',
        );
        return;
      }
    } catch (err) {
      log.warn({ err }, 'failed to read cloud ranges from Redis');
    }
  }

  // Fetch from APIs
  const raw = await fetchCloudRangesFromApis();

  if (Object.keys(raw).length === 0) {
    log.warn('no cloud ranges fetched from any provider');
    return;
  }

  cachedRanges = parseRawRanges(raw);
  cacheLoadedAt = Date.now();

  // Persist to Redis
  if (redis) {
    try {
      await redis.set(CACHE_KEY, JSON.stringify(raw), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
      log.warn({ err }, 'failed to persist cloud ranges to Redis');
    }
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Check an IP against cached cloud provider CIDR ranges.
 *
 * Returns the provider name (e.g. "AWS", "GCP", "Cloudflare") or null.
 * Call `loadCloudRanges()` at least once before using this.
 */
export function detectCloudProviderByIp(ip: string): string | null {
  let addr: bigint;
  let bits: 32 | 128;

  if (ip.includes(':')) {
    const expanded = expandIpv6(ip);
    if (!expanded) return null;
    addr = ipv6ToBigInt(expanded);
    bits = 128;
  } else {
    const n = ipv4ToUint32(ip);
    if (n === null) return null;
    addr = BigInt(n);
    bits = 32;
  }

  for (const [provider, ranges] of cachedRanges) {
    for (const range of ranges) {
      if (range.bits !== bits) continue;
      if ((addr & range.mask) === range.base) return provider;
    }
  }

  return null;
}

/**
 * Returns true if cloud ranges have been loaded (at least one provider present).
 */
export function hasCloudRanges(): boolean {
  return cachedRanges.size > 0;
}
