import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';

// ---------------------------------------------------------------------------
// Mock env() before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('@sentinel/shared/env', () => ({
  env: vi.fn(),
}));

vi.mock('@sentinel/shared/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

import { env } from '@sentinel/shared/env';
import { fetchVtSubdomains } from '../scanner/steps/virustotal-subdomains.js';

const mockEnv = vi.mocked(env);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

function vtPage(ids: string[], nextUrl?: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: ids.map((id) => ({ id })),
      links: nextUrl ? { next: nextUrl } : {},
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  mockEnv.mockReturnValue({ VIRUSTOTAL_API_KEY: 'test-vt-key' } as ReturnType<typeof env>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchVtSubdomains — no API key', () => {
  it('returns empty immediately when VIRUSTOTAL_API_KEY is unset', async () => {
    mockEnv.mockReturnValue({ VIRUSTOTAL_API_KEY: undefined } as unknown as ReturnType<typeof env>);

    const result = await fetchVtSubdomains('example.com', {});

    expect(result).toEqual({ subdomains: [], pagesFetched: 0, rateLimited: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('fetchVtSubdomains — response parsing', () => {
  it('extracts subdomain ids from VT v3 response', async () => {
    mockFetch.mockResolvedValueOnce(vtPage(['api.example.com', 'www.example.com']));

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains).toEqual(['api.example.com', 'www.example.com']);
    expect(result.pagesFetched).toBe(1);
    expect(result.rateLimited).toBe(false);
  });

  it('sends x-apikey header', async () => {
    mockFetch.mockResolvedValueOnce(vtPage([]));

    await fetchVtSubdomains('example.com', {});

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/domains/example.com/subdomains'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-apikey': 'test-vt-key' }),
      }),
    );
  });

  it('handles empty data array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [], links: {} }),
    });

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains).toEqual([]);
    expect(result.pagesFetched).toBe(1);
  });

  it('handles missing data field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ links: {} }),
    });

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains).toEqual([]);
    expect(result.pagesFetched).toBe(1);
  });
});

describe('fetchVtSubdomains — pagination', () => {
  it('follows links.next for multiple pages', async () => {
    mockFetch
      .mockResolvedValueOnce(vtPage(['a.example.com'], 'https://vt.com/page2'))
      .mockResolvedValueOnce(vtPage(['b.example.com'], 'https://vt.com/page3'))
      .mockResolvedValueOnce(vtPage(['c.example.com']));

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
    expect(result.pagesFetched).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('caps at 10 pages', async () => {
    for (let i = 0; i < 11; i++) {
      mockFetch.mockResolvedValueOnce(vtPage([`sub${i}.example.com`], `https://vt.com/page${i + 2}`));
    }

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.pagesFetched).toBe(10);
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });

  it('caps at 200 subdomains', async () => {
    // Each page returns 20 subdomains, so 10 pages = 200 subdomains
    for (let i = 0; i < 11; i++) {
      const ids = Array.from({ length: 20 }, (_, j) => `s${i * 20 + j}.example.com`);
      mockFetch.mockResolvedValueOnce(vtPage(ids, `https://vt.com/page${i + 2}`));
    }

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains.length).toBe(200);
  });
});

describe('fetchVtSubdomains — 429 handling', () => {
  it('returns partial results on HTTP 429', async () => {
    mockFetch
      .mockResolvedValueOnce(vtPage(['a.example.com'], 'https://vt.com/page2'))
      .mockResolvedValueOnce({ ok: false, status: 429 });

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains).toEqual(['a.example.com']);
    expect(result.rateLimited).toBe(true);
    expect(result.pagesFetched).toBe(1);
  });
});

describe('fetchVtSubdomains — network errors', () => {
  it('returns partial results on network error', async () => {
    mockFetch
      .mockResolvedValueOnce(vtPage(['a.example.com'], 'https://vt.com/page2'))
      .mockRejectedValueOnce(new Error('network timeout'));

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains).toEqual(['a.example.com']);
    expect(result.pagesFetched).toBe(1);
    expect(result.rateLimited).toBe(false);
  });

  it('returns empty on immediate network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('DNS failed'));

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains).toEqual([]);
    expect(result.pagesFetched).toBe(0);
    expect(result.rateLimited).toBe(false);
  });
});

describe('fetchVtSubdomains — non-OK status', () => {
  it('returns empty on 403', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.subdomains).toEqual([]);
    expect(result.pagesFetched).toBe(0);
  });
});

describe('fetchVtSubdomains — Redis rate limiter', () => {
  it('stops fetching when rate limiter rejects', async () => {
    const redis = new Redis();
    // Fill up the rate limit window (4 allowed)
    mockFetch
      .mockResolvedValueOnce(vtPage(['a.example.com'], 'https://vt.com/p2'))
      .mockResolvedValueOnce(vtPage(['b.example.com'], 'https://vt.com/p3'))
      .mockResolvedValueOnce(vtPage(['c.example.com'], 'https://vt.com/p4'))
      .mockResolvedValueOnce(vtPage(['d.example.com'], 'https://vt.com/p5'))
      .mockResolvedValueOnce(vtPage(['e.example.com']));

    const result = await fetchVtSubdomains('example.com', { redis: redis as unknown as import('ioredis').default });

    // Should have fetched 4 pages (rate limit max) then been rejected on the 5th
    expect(result.pagesFetched).toBe(4);
    expect(result.subdomains).toEqual(['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com']);
    expect(result.rateLimited).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('fetches without rate limiting when no Redis provided', async () => {
    mockFetch
      .mockResolvedValueOnce(vtPage(['a.example.com'], 'https://vt.com/p2'))
      .mockResolvedValueOnce(vtPage(['b.example.com'], 'https://vt.com/p3'))
      .mockResolvedValueOnce(vtPage(['c.example.com'], 'https://vt.com/p4'))
      .mockResolvedValueOnce(vtPage(['d.example.com'], 'https://vt.com/p5'))
      .mockResolvedValueOnce(vtPage(['e.example.com']));

    const result = await fetchVtSubdomains('example.com', {});

    expect(result.pagesFetched).toBe(5);
    expect(result.subdomains).toHaveLength(5);
    expect(result.rateLimited).toBe(false);
  });
});
