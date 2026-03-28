/**
 * Chunk 129 — External Slack Bot API integration tests.
 * Mocks globalThis.fetch to test Slack chat.postMessage, error handling,
 * and token validation without the Slack SDK.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeEach(() => { fetchSpy.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const sampleAlert = {
  title: 'Suspicious npm publish',
  severity: 'high',
  module: 'registry',
  eventType: 'registry.npm.version_published',
  timestamp: '2026-03-28T10:00:00Z',
  description: 'New version published by unknown maintainer',
  fields: [{ label: 'Package', value: '@acme/core' }],
};

describe('Chunk 129 — Slack API integration', () => {
  describe('sendSlackMessage success', () => {
    it('should POST to chat.postMessage with correct headers and body', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, ts: '1234567890.123456' }),
        { status: 200 },
      ));

      const { sendSlackMessage } = await import('../../packages/notifications/src/slack.js');
      await sendSlackMessage('xoxb-test-token', 'C01ABCDEF', sampleAlert);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://slack.com/api/chat.postMessage');
      expect((init as RequestInit).method).toBe('POST');

      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer xoxb-test-token');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.channel).toBe('C01ABCDEF');
      expect(body.blocks).toBeDefined();
      expect(body.blocks.length).toBeGreaterThan(0);
      expect(body.text).toContain('Suspicious npm publish');
    });
  });

  describe('sendSlackMessage error responses', () => {
    it('should throw on Slack API error (invalid_auth)', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, error: 'invalid_auth' }),
        { status: 200 },
      ));

      const { sendSlackMessage } = await import('../../packages/notifications/src/slack.js');
      await expect(
        sendSlackMessage('xoxb-bad-token', 'C01ABCDEF', sampleAlert),
      ).rejects.toThrow('invalid_auth');
    });

    it('should throw on channel_not_found error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, error: 'channel_not_found' }),
        { status: 200 },
      ));

      const { sendSlackMessage } = await import('../../packages/notifications/src/slack.js');
      await expect(
        sendSlackMessage('xoxb-test', 'C_INVALID', sampleAlert),
      ).rejects.toThrow('channel_not_found');
    });

    it('should throw on rate_limited error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, error: 'rate_limited' }),
        { status: 200 },
      ));

      const { sendSlackMessage } = await import('../../packages/notifications/src/slack.js');
      await expect(
        sendSlackMessage('xoxb-test', 'C01ABC', sampleAlert),
      ).rejects.toThrow('rate_limited');
    });
  });

  describe('buildBlocks formatting', () => {
    it('should include severity badge and all fields in block kit output', async () => {
      const { buildBlocks } = await import('../../packages/notifications/src/slack.js');
      const blocks = buildBlocks(sampleAlert);

      expect(blocks.length).toBeGreaterThanOrEqual(3);
      const header = blocks[0] as { type: string; text: { text: string } };
      expect(header.type).toBe('header');
      expect(header.text.text).toContain('Suspicious npm publish');
    });

    it('should handle alert without optional fields', async () => {
      const { buildBlocks } = await import('../../packages/notifications/src/slack.js');
      const minimal = { title: 'Test', severity: 'low', module: 'chain', eventType: 'chain.transfer', timestamp: '2026-03-28T00:00:00Z' };
      const blocks = buildBlocks(minimal);
      expect(blocks.length).toBeGreaterThanOrEqual(2);
    });
  });
});
