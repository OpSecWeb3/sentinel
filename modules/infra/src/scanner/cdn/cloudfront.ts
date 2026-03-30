import type { Redis } from 'ioredis';

import { logger as rootLogger } from '@sentinel/shared/logger';

const log = rootLogger.child({ component: 'cdn-cloudfront' });
const DIST_CACHE_PREFIX = 'cache:cfdist:';
const DIST_CACHE_TTL = 3_600; // 1 hour

interface CFClient {
  send: (cmd: unknown) => Promise<unknown>;
}

async function makeClient(accessKeyId: string, secretAccessKey: string, region: string): Promise<CFClient> {
  const { CloudFrontClient } = await import('@aws-sdk/client-cloudfront');
  return new CloudFrontClient({
    region: region || 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
  }) as unknown as CFClient;
}

export async function validateCredentials(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
): Promise<{ valid: boolean; message: string }> {
  try {
    const { ListDistributionsCommand } = await import('@aws-sdk/client-cloudfront');
    const client = await makeClient(accessKeyId, secretAccessKey, region);
    // Minimal list call with MaxItems=1 to verify credentials without fetching all distributions
    await client.send(new ListDistributionsCommand({ MaxItems: 1 }));
    return { valid: true, message: 'CloudFront credentials valid' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'CloudFront credential validation failed');
    if (msg.includes('InvalidClientTokenId') || msg.includes('AuthFailure') || msg.includes('SignatureDoesNotMatch')) {
      return { valid: false, message: 'Invalid AWS credentials' };
    }
    if (msg.includes('Cannot find module')) {
      return { valid: false, message: 'CloudFront SDK not installed — run pnpm install in modules/infra' };
    }
    return { valid: false, message: msg };
  }
}

interface CachedDistribution {
  domainName: string;
  aliases: string[];
  origins: string[];
}

/** Fetch all distributions, using Redis cache (1h TTL) keyed by credential hash. */
async function listAllDistributions(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  redis?: Redis,
): Promise<CachedDistribution[]> {
  // Cache key uses a prefix of the access key ID (safe — not a secret)
  const cacheKey = `${DIST_CACHE_PREFIX}${accessKeyId.slice(0, 8)}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as CachedDistribution[];
    } catch { /* cache miss */ }
  }

  const { ListDistributionsCommand } = await import('@aws-sdk/client-cloudfront');
  const client = await makeClient(accessKeyId, secretAccessKey, region);

  const distributions: CachedDistribution[] = [];
  let marker: string | undefined;

  do {
    const resp = await client.send(new ListDistributionsCommand({
      MaxItems: 100,
      ...(marker ? { Marker: marker } : {}),
    })) as {
      DistributionList?: {
        NextMarker?: string;
        IsTruncated?: boolean;
        Items?: Array<{
          DomainName?: string;
          Aliases?: { Items?: string[] };
          Origins?: { Items?: Array<{ DomainName?: string }> };
        }>;
      };
    };

    const list = resp.DistributionList;
    if (!list?.Items) break;

    for (const dist of list.Items) {
      distributions.push({
        domainName: dist.DomainName ?? '',
        aliases: dist.Aliases?.Items ?? [],
        origins: (dist.Origins?.Items ?? []).map((o) => o.DomainName).filter(Boolean) as string[],
      });
    }

    marker = list.IsTruncated ? list.NextMarker : undefined;
  } while (marker);

  if (redis && distributions.length > 0) {
    try { await redis.set(cacheKey, JSON.stringify(distributions), 'EX', DIST_CACHE_TTL); } catch { /* non-fatal */ }
  }

  return distributions;
}

export async function getOriginDomains(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  domain: string,
  options?: { redis?: Redis },
): Promise<string[]> {
  try {
    const distributions = await listAllDistributions(accessKeyId, secretAccessKey, region, options?.redis);

    const origins: string[] = [];
    const domainLower = domain.toLowerCase();

    for (const dist of distributions) {
      const isMatch =
        dist.domainName.toLowerCase() === domainLower ||
        dist.aliases.some((a) => a.toLowerCase() === domainLower || domainLower.endsWith(`.${a.toLowerCase()}`));

      if (isMatch) {
        origins.push(...dist.origins);
      }
    }

    return [...new Set(origins)];
  } catch (err) {
    log.warn({ err, domain }, 'CloudFront origin lookup failed');
    return [];
  }
}
