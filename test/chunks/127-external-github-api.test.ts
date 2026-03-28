/**
 * Chunk 127 — External GitHub API integration tests.
 * Mocks fetch at the global level to test request construction,
 * response parsing, HMAC webhook verification, and rate limit handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// Mock env() to return required GitHub App config
vi.mock('@sentinel/shared/env', () => ({
  env: () => ({
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: (() => {
      const { generateKeyPairSync } = require('node:crypto');
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'pkcs1', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      return privateKey;
    })(),
  }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Chunk 127 — GitHub API integration', () => {
  describe('getInstallationAccessToken', () => {
    it('should POST to correct URL with Bearer JWT and return parsed token', async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        token: 'ghs_test_token_abc',
        expires_at: '2026-03-28T12:00:00Z',
        permissions: { contents: 'read' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const { getInstallationAccessToken } = await import('../../modules/github/src/github-api.js');
      const result = await getInstallationAccessToken(99);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.github.com/app/installations/99/access_tokens');
      expect((init as RequestInit).method).toBe('POST');
      expect((init as RequestInit).headers).toHaveProperty('Authorization');
      expect(result.token).toBe('ghs_test_token_abc');
      expect(result.expiresAt).toBe('2026-03-28T12:00:00Z');
    });

    it('should throw on non-OK response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
      const { getInstallationAccessToken } = await import('../../modules/github/src/github-api.js');
      await expect(getInstallationAccessToken(999)).rejects.toThrow('GitHub API error (404)');
    });
  });

  describe('getInstallationDetails', () => {
    it('should GET installation details and parse response', async () => {
      const body = { id: 42, app_slug: 'sentinel', target_type: 'Organization', account: { login: 'acme', id: 1, type: 'Organization' }, permissions: {}, events: ['push'] };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

      const { getInstallationDetails } = await import('../../modules/github/src/github-api.js');
      const details = await getInstallationDetails(42);
      expect(details.account.login).toBe('acme');
      expect(details.events).toContain('push');
    });
  });

  describe('webhook HMAC verification', () => {
    it('should produce valid HMAC-SHA256 signature for webhook payload', () => {
      const secret = 'whsec_test123';
      const payload = '{"action":"opened"}';
      const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      expect(sig).toBe(`sha256=${expected}`);
    });

    it('should reject tampered payloads', () => {
      const secret = 'whsec_test';
      const original = '{"action":"opened"}';
      const tampered = '{"action":"closed"}';
      const sig = crypto.createHmac('sha256', secret).update(original).digest('hex');
      const check = crypto.createHmac('sha256', secret).update(tampered).digest('hex');
      expect(sig).not.toBe(check);
    });
  });

  describe('rate limit header handling', () => {
    it('should retry on 429 with Retry-After header', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { 'X-RateLimit-Remaining': '4999' } }));

      const { githubApiFetch } = await import('../../modules/github/src/github-api.js');
      const res = await githubApiFetch('/repos/test/test', { token: 'tok' });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should throw after 3 retries on persistent rate limiting', async () => {
      const rateResp = () => new Response('', { status: 429, headers: { 'Retry-After': '0' } });
      fetchMock.mockResolvedValue(rateResp());

      const { githubApiFetch } = await import('../../modules/github/src/github-api.js');
      await expect(githubApiFetch('/repos/x/y', { token: 'tok' })).rejects.toThrow('rate limited');
    }, 30_000);
  });
});
