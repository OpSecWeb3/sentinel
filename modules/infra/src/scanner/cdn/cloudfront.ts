import { logger as rootLogger } from '@sentinel/shared/logger';

const log = rootLogger.child({ component: 'cdn-cloudfront' });

interface CloudFrontClient {
  send: (cmd: unknown) => Promise<unknown>;
}

async function makeClient(accessKeyId: string, secretAccessKey: string, region: string): Promise<CloudFrontClient> {
  const { CloudFrontClient } = await import('@aws-sdk/client-cloudfront');
  return new CloudFrontClient({
    region: region || 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
  });
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

export async function getOriginDomains(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  domain: string,
): Promise<string[]> {
  try {
    const { ListDistributionsCommand } = await import('@aws-sdk/client-cloudfront');
    const client = await makeClient(accessKeyId, secretAccessKey, region);

    const origins: string[] = [];
    let marker: string | undefined;

    // Page through all distributions
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
        // Match if the distribution's CloudFront domain or any CNAME alias matches the queried domain
        const aliases = dist.Aliases?.Items ?? [];
        const cfDomain = dist.DomainName ?? '';

        const domainLower = domain.toLowerCase();
        const isMatch =
          cfDomain.toLowerCase() === domainLower ||
          aliases.some((a) => a.toLowerCase() === domainLower || domainLower.endsWith(`.${a.toLowerCase()}`));

        if (isMatch) {
          for (const origin of dist.Origins?.Items ?? []) {
            if (origin.DomainName) origins.push(origin.DomainName);
          }
        }
      }

      marker = list.IsTruncated ? list.NextMarker : undefined;
    } while (marker);

    return [...new Set(origins)];
  } catch (err) {
    log.warn({ err, domain }, 'CloudFront origin lookup failed');
    return [];
  }
}
