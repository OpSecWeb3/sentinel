/**
 * Custom webhook delivery with HMAC-SHA256 signing and SSRF protection.
 * Ported from ChainAlert.
 */
import { createHmac } from 'node:crypto';
import dns from 'node:dns/promises';

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / AWS IMDS
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark testing (RFC 2544)
  if (a >= 240) return true; // reserved (RFC 1112)
  if (ip === '255.255.255.255') return true; // broadcast
  return false;
}

function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) {
    const n = ip.toLowerCase();
    if (n === '::1' || n === '::') return true; // loopback / unspecified
    if (n.startsWith('fc') || n.startsWith('fd')) return true; // ULA
    if (n.startsWith('fe8') || n.startsWith('fe9') || n.startsWith('fea') || n.startsWith('feb')) return true; // link-local (fe80::/10)
    const m = n.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIPv4(m[1]);
    return false;
  }
  return isPrivateIPv4(ip);
}

/**
 * Validates that a webhook URL does not resolve to a private/reserved IP.
 *
 * Note: This uses a validate-then-fetch pattern rather than DNS pinning.
 * DNS pinning (replacing the hostname with the resolved IP) breaks TLS for
 * HTTPS URLs because the TLS SNI extension uses the URL hostname, and most
 * servers will not present a valid certificate for a bare IP address.
 * The small TOCTOU window between validation and fetch is acceptable — this
 * is the standard approach used by most webhook senders (including ChainAlert).
 */
async function validateExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
  }
  const { address } = await dns.lookup(parsed.hostname);
  if (isPrivateIP(address)) {
    throw new Error('Webhook URL resolves to a private/reserved IP address');
  }
}

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

export interface WebhookConfig {
  url: string;
  secret: string;
  headers?: Record<string, string>;
}

export async function sendWebhookNotification(
  config: WebhookConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  // SSRF protection: validate URL resolves to a public IP before fetching.
  await validateExternalUrl(config.url);

  const body = JSON.stringify({
    event: 'alert.triggered',
    timestamp: new Date().toISOString(),
    ...payload,
  });

  const signature = createHmac('sha256', config.secret).update(body).digest('hex');

  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature,
      ...(config.headers ?? {}),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown error');
    throw new Error(`Webhook POST to ${config.url} failed (${res.status}): ${text}`);
  }
}
