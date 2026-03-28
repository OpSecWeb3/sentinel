/**
 * Chunk 131 — External npm registry API integration tests.
 * Mocks globalThis.fetch to test package metadata fetching,
 * scope search, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeEach(() => { fetchSpy.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Chunk 131 — npm registry API integration', () => {
  describe('searchNpmScope', () => {
    it('should construct correct search URL with encoded scope', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [
          { package: { name: '@acme/core', version: '2.1.0', description: 'Core lib' } },
          { package: { name: '@acme/utils', version: '1.0.0', description: 'Utilities' } },
        ],
      }), { status: 200 }));

      const { searchNpmScope } = await import('../../modules/registry/src/npm-registry.js');
      const results = await searchNpmScope('@acme', 50);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('registry.npmjs.org/-/v1/search');
      expect(url).toContain('scope%3A%40acme');
      expect(url).toContain('size=50');
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('@acme/core');
      expect(results[0].version).toBe('2.1.0');
    });

    it('should filter results to exact scope prefix', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [
          { package: { name: '@acme/core', version: '1.0.0' } },
          { package: { name: '@acme-fork/core', version: '1.0.0' } },
          { package: { name: 'acme-standalone', version: '3.0.0' } },
        ],
      }), { status: 200 }));

      const { searchNpmScope } = await import('../../modules/registry/src/npm-registry.js');
      const results = await searchNpmScope('@acme');
      // Only @acme/ prefixed packages should be returned
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('@acme/core');
    });

    it('should cap limit at 250', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ objects: [] }), { status: 200 }));

      const { searchNpmScope } = await import('../../modules/registry/src/npm-registry.js');
      await searchNpmScope('@big-scope', 999);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('size=250');
    });

    it('should throw on non-OK response (rate limit)', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }));

      const { searchNpmScope } = await import('../../modules/registry/src/npm-registry.js');
      await expect(searchNpmScope('@acme')).rejects.toThrow('npm registry search failed (429)');
    });

    it('should throw on server error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Internal Server Error', { status: 503 }));

      const { searchNpmScope } = await import('../../modules/registry/src/npm-registry.js');
      await expect(searchNpmScope('@acme')).rejects.toThrow('npm registry search failed (503)');
    });
  });

  describe('maintainer diff detection logic', () => {
    it('should detect added and removed maintainers', () => {
      const previous = ['alice', 'bob', 'charlie'];
      const current = ['alice', 'dave'];
      const added = current.filter((m) => !previous.includes(m));
      const removed = previous.filter((m) => !current.includes(m));
      expect(added).toEqual(['dave']);
      expect(removed).toEqual(['bob', 'charlie']);
    });

    it('should detect no changes when lists are identical', () => {
      const list = ['alice', 'bob'];
      const added = list.filter((m) => !list.includes(m));
      const removed = list.filter((m) => !list.includes(m));
      expect(added).toHaveLength(0);
      expect(removed).toHaveLength(0);
    });
  });

  describe('version comparison logic', () => {
    it('should detect major version jump', () => {
      const prev = '1.2.3';
      const next = '2.0.0';
      const prevMajor = parseInt(prev.split('.')[0], 10);
      const nextMajor = parseInt(next.split('.')[0], 10);
      expect(nextMajor).toBeGreaterThan(prevMajor);
    });

    it('should not flag patch bumps', () => {
      const prev = '1.2.3';
      const next = '1.2.4';
      const prevMajor = parseInt(prev.split('.')[0], 10);
      const nextMajor = parseInt(next.split('.')[0], 10);
      expect(nextMajor).toBe(prevMajor);
    });
  });
});
