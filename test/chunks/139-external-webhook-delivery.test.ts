/**
 * Chunk 139 — External webhook delivery tests.
 * Mocks globalThis.fetch and dns.lookup to test HMAC signing,
 * SSRF DNS blocking, timeout handling, and delivery errors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
  lookup: vi.fn(),
}));

import dns from 'node:dns/promises';
const dnsLookup = vi.mocked(dns.lookup);

beforeEach(() => {
  fetchMock.mockReset();
  dnsLookup.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Chunk 139 — Webhook delivery', () => {
  describe('HMAC signature generation', () => {
    it('should include X-Signature header with correct HMAC-SHA256', async () => {
      dnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 } as any);
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const { sendWebhookNotification } = await import('../../packages/notifications/src/webhook.js');
      await sendWebhookNotification(
        { url: 'https://hooks.example.com/abc', secret: 'wh_secret_123' },
        { alertId: 'a1', severity: 'high' },
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0];
      const headers = (init as RequestInit).headers as Record<string, string>;
      const body = (init as RequestInit).body as string;

      // Verify the signature matches what we'd compute ourselves
      const expected = createHmac('sha256', 'wh_secret_123').update(body).digest('hex');
      expect(headers['X-Signature']).toBe(expected);
    });

    it('should include event type and timestamp in body', async () => {
      dnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 } as any);
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const { sendWebhookNotification } = await import('../../packages/notifications/src/webhook.js');
      await sendWebhookNotification(
        { url: 'https://hooks.example.com/abc', secret: 'sec' },
        { alertId: 'a2' },
      );

      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.event).toBe('alert.triggered');
      expect(body.timestamp).toBeDefined();
      expect(body.alertId).toBe('a2');
    });
  });

  describe('SSRF DNS resolution blocking', () => {
    it('should block webhooks resolving to private 10.x.x.x', async () => {
      dnsLookup.mockResolvedValueOnce({ address: '10.0.0.1', family: 4 } as any);

      const { sendWebhookNotification } = await import('../../packages/notifications/src/webhook.js');
      await expect(
        sendWebhookNotification({ url: 'https://evil.com/hook', secret: 's' }, {}),
      ).rejects.toThrow('private');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should block webhooks resolving to 127.0.0.1', async () => {
      dnsLookup.mockResolvedValueOnce({ address: '127.0.0.1', family: 4 } as any);

      const { sendWebhookNotification } = await import('../../packages/notifications/src/webhook.js');
      await expect(
        sendWebhookNotification({ url: 'https://localhost.evil.com/hook', secret: 's' }, {}),
      ).rejects.toThrow('private');
    });

    it('should block 169.254.169.254 (AWS IMDS)', async () => {
      dnsLookup.mockResolvedValueOnce({ address: '169.254.169.254', family: 4 } as any);

      const { sendWebhookNotification } = await import('../../packages/notifications/src/webhook.js');
      await expect(
        sendWebhookNotification({ url: 'https://metadata.evil.com/hook', secret: 's' }, {}),
      ).rejects.toThrow('private');
    });

    it('should allow webhooks resolving to public IPs', async () => {
      dnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 } as any);
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const { sendWebhookNotification } = await import('../../packages/notifications/src/webhook.js');
      await sendWebhookNotification({ url: 'https://hooks.example.com/ok', secret: 's' }, {});
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('delivery error handling', () => {
    it('should throw on non-OK response with status and body', async () => {
      dnsLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 } as any);
      fetchMock.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

      const { sendWebhookNotification } = await import('../../packages/notifications/src/webhook.js');
      await expect(
        sendWebhookNotification({ url: 'https://hooks.example.com/err', secret: 's' }, {}),
      ).rejects.toThrow('400');
    });

    it('should reject non-http/https URL schemes', async () => {
      const { sendWebhookNotification } = await import('../../packages/notifications/src/webhook.js');
      await expect(
        sendWebhookNotification({ url: 'ftp://evil.com/hook', secret: 's' }, {}),
      ).rejects.toThrow('Disallowed URL scheme');
    });
  });
});
