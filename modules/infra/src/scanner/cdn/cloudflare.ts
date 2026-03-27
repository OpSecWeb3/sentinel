import { logger as rootLogger } from '@sentinel/shared/logger';

const log = rootLogger.child({ component: 'cdn-cloudflare' });
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

async function cfFetch(url: string, apiToken: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function validateCredentials(apiToken: string, accountId: string): Promise<{ valid: boolean; message: string }> {
  try {
    const resp = await cfFetch(`${CF_API_BASE}/accounts/${accountId}/tokens/verify`, apiToken);
    const data = await resp.json() as { success: boolean; errors?: Array<{ message: string }> };
    if (resp.ok && data.success) return { valid: true, message: 'Token verified successfully' };
    const msg = data.errors?.[0]?.message ?? 'Invalid token';
    return { valid: false, message: msg };
  } catch (err) {
    log.error({ err }, 'Cloudflare credential validation failed');
    return { valid: false, message: `Connection error: ${err}` };
  }
}

export async function getOriginIps(apiToken: string, domain: string): Promise<Record<string, string[]>> {
  const zoneId = await getZoneId(apiToken, domain);
  if (!zoneId) return {};

  const origins: Record<string, string[]> = {};
  for (const rtype of ['A', 'AAAA'] as const) {
    try {
      const resp = await cfFetch(
        `${CF_API_BASE}/zones/${zoneId}/dns_records?type=${rtype}&name=${encodeURIComponent(domain)}`,
        apiToken,
      );
      const data = await resp.json() as { success: boolean; result?: Array<{ content: string }> };
      if (data.success && data.result?.length) {
        origins[rtype] = data.result.map((r) => r.content);
      }
    } catch (err) {
      log.error({ err, domain, rtype }, 'Cloudflare get origin IPs failed');
    }
  }
  return origins;
}

async function getZoneId(apiToken: string, domain: string): Promise<string | null> {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    try {
      const resp = await cfFetch(
        `${CF_API_BASE}/zones?name=${encodeURIComponent(candidate)}&status=active`,
        apiToken,
      );
      const data = await resp.json() as { success: boolean; result?: Array<{ id: string }> };
      if (data.success && data.result?.length) {
        return data.result[0].id;
      }
    } catch (err) {
      log.error({ err, candidate }, 'Cloudflare zone lookup failed');
    }
  }
  return null;
}
