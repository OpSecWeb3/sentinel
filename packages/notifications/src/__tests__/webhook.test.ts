import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock dns.lookup to control IP resolution for SSRF tests
// ---------------------------------------------------------------------------
let dnsLookupResult = { address: '93.184.216.34', family: 4 }; // public by default

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(async () => dnsLookupResult),
  },
}));

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { sendWebhookNotification } from '../webhook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setDnsResult(address: string, family = 4) {
  dnsLookupResult = { address, family };
}

const baseConfig = { url: 'https://example.com/hook', secret: 'test-secret-key' };

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
  setDnsResult('93.184.216.34');
});

// ---------------------------------------------------------------------------
// SSRF protection - IPv4 private ranges
// ---------------------------------------------------------------------------
describe('SSRF protection - IPv4', () => {
  const privateIPs = [
    { ip: '127.0.0.1', label: 'loopback 127.0.0.1' },
    { ip: '127.0.0.2', label: 'loopback 127.x.x.x range' },
    { ip: '10.0.0.1', label: '10.x.x.x private' },
    { ip: '10.255.255.255', label: '10.x.x.x upper bound' },
    { ip: '172.16.0.1', label: '172.16.x.x private' },
    { ip: '172.31.255.255', label: '172.31.x.x upper bound' },
    { ip: '192.168.0.1', label: '192.168.x.x private' },
    { ip: '192.168.255.255', label: '192.168.x.x upper bound' },
    { ip: '169.254.169.254', label: 'link-local / AWS IMDS' },
    { ip: '169.254.0.1', label: 'link-local range' },
    { ip: '0.0.0.0', label: 'zero address' },
  ];

  for (const { ip, label } of privateIPs) {
    it(`blocks ${label} (${ip})`, async () => {
      setDnsResult(ip);
      await expect(
        sendWebhookNotification(baseConfig, { data: 'test' }),
      ).rejects.toThrow(/private|reserved/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('allows edge IPs just outside private ranges', async () => {
    // 172.15.x.x is NOT private (just below 172.16)
    setDnsResult('172.15.255.255');
    await sendWebhookNotification(baseConfig, { data: 'test' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows 172.32.x.x (just above 172.31)', async () => {
    setDnsResult('172.32.0.1');
    await sendWebhookNotification(baseConfig, { data: 'test' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// SSRF protection - IPv6
// ---------------------------------------------------------------------------
describe('SSRF protection - IPv6', () => {
  it('blocks IPv6 loopback ::1', async () => {
    setDnsResult('::1', 6);
    await expect(
      sendWebhookNotification(baseConfig, { data: 'test' }),
    ).rejects.toThrow(/private|reserved/i);
  });

  it('blocks IPv6 ULA fc00::', async () => {
    setDnsResult('fc00::1', 6);
    await expect(
      sendWebhookNotification(baseConfig, { data: 'test' }),
    ).rejects.toThrow(/private|reserved/i);
  });

  it('blocks IPv6 ULA fd00::', async () => {
    setDnsResult('fd12:3456:789a::1', 6);
    await expect(
      sendWebhookNotification(baseConfig, { data: 'test' }),
    ).rejects.toThrow(/private|reserved/i);
  });

  it('blocks IPv4-mapped IPv6 ::ffff:127.0.0.1', async () => {
    setDnsResult('::ffff:127.0.0.1', 6);
    await expect(
      sendWebhookNotification(baseConfig, { data: 'test' }),
    ).rejects.toThrow(/private|reserved/i);
  });

  it('blocks IPv4-mapped IPv6 ::ffff:10.0.0.1', async () => {
    setDnsResult('::ffff:10.0.0.1', 6);
    await expect(
      sendWebhookNotification(baseConfig, { data: 'test' }),
    ).rejects.toThrow(/private|reserved/i);
  });

  it('blocks IPv4-mapped IPv6 ::ffff:192.168.1.1', async () => {
    setDnsResult('::ffff:192.168.1.1', 6);
    await expect(
      sendWebhookNotification(baseConfig, { data: 'test' }),
    ).rejects.toThrow(/private|reserved/i);
  });

  it('allows public IPv6 address', async () => {
    setDnsResult('2607:f8b0:4004:800::200e', 6);
    await sendWebhookNotification(baseConfig, { data: 'test' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// SSRF protection - public IPs
// ---------------------------------------------------------------------------
describe('SSRF protection - public IPs', () => {
  const publicIPs = ['93.184.216.34', '1.1.1.1', '8.8.8.8', '203.0.113.1'];

  for (const ip of publicIPs) {
    it(`allows public IP ${ip}`, async () => {
      setDnsResult(ip);
      await sendWebhookNotification(baseConfig, { data: 'test' });
      expect(fetchMock).toHaveBeenCalledOnce();
      fetchMock.mockClear();
    });
  }
});

// ---------------------------------------------------------------------------
// SSRF protection - protocol validation
// ---------------------------------------------------------------------------
describe('SSRF protection - protocol', () => {
  it('blocks non-http(s) schemes', async () => {
    await expect(
      sendWebhookNotification({ ...baseConfig, url: 'ftp://example.com/hook' }, {}),
    ).rejects.toThrow(/scheme/i);
  });

  it('blocks file:// URLs', async () => {
    await expect(
      sendWebhookNotification({ ...baseConfig, url: 'file:///etc/passwd' }, {}),
    ).rejects.toThrow(/scheme/i);
  });
});

// ---------------------------------------------------------------------------
// HMAC signature
// ---------------------------------------------------------------------------
describe('webhook HMAC signature', () => {
  it('sends X-Signature header with correct HMAC-SHA256', async () => {
    setDnsResult('93.184.216.34');
    await sendWebhookNotification(baseConfig, { data: 'hello' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, reqInit] = fetchMock.mock.calls[0];
    const body = reqInit.body as string;
    const sentSignature = reqInit.headers['X-Signature'];

    // Verify the signature matches
    const expected = createHmac('sha256', baseConfig.secret).update(body).digest('hex');
    expect(sentSignature).toBe(expected);
  });

  it('signature is 64-char hex string', async () => {
    await sendWebhookNotification(baseConfig, { data: 'test' });
    const [, reqInit] = fetchMock.mock.calls[0];
    expect(reqInit.headers['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Webhook payload structure
// ---------------------------------------------------------------------------
describe('webhook payload', () => {
  it('includes event, timestamp, and data', async () => {
    await sendWebhookNotification(baseConfig, { data: { foo: 'bar' } });

    const [, reqInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(reqInit.body as string);

    expect(body).toHaveProperty('event', 'alert.triggered');
    expect(body).toHaveProperty('timestamp');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp); // valid ISO
    expect(body).toHaveProperty('data', { foo: 'bar' });
  });

  it('sends Content-Type application/json', async () => {
    await sendWebhookNotification(baseConfig, {});
    const [, reqInit] = fetchMock.mock.calls[0];
    expect(reqInit.headers['Content-Type']).toBe('application/json');
  });

  it('includes custom headers from config', async () => {
    const config = { ...baseConfig, headers: { 'X-Custom': 'value' } };
    await sendWebhookNotification(config, {});
    const [, reqInit] = fetchMock.mock.calls[0];
    expect(reqInit.headers['X-Custom']).toBe('value');
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    await expect(
      sendWebhookNotification(baseConfig, {}),
    ).rejects.toThrow(/500/);
  });
});
