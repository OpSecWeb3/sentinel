/**
 * Chunk 135 — External Etherscan API integration tests.
 * Mocks globalThis.fetch to test contract ABI fetching,
 * verification responses, and rate limit / retry handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeEach(() => { fetchSpy.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const SAMPLE_ABI = JSON.stringify([{ type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }]);

describe('Chunk 135 — Etherscan API integration', () => {
  describe('fetchContractAbi with V2 endpoint', () => {
    it('should use V2 URL when chainId is provided and explorerApi is empty', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', message: 'OK', result: SAMPLE_ABI }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', result: [{ ContractName: 'TestToken' }] }), { status: 200 }));

      const { fetchContractAbi } = await import('../../modules/chain/src/etherscan.js');
      const result = await fetchContractAbi('', '0xdead', { chainId: 1, apiKey: 'testkey' });

      const [url] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('api.etherscan.io/v2/api');
      expect(String(url)).toContain('chainid=1');
      expect(String(url)).toContain('apikey=testkey');
      expect(String(url)).toContain('action=getabi');
      expect(result.abi).toHaveLength(1);
      expect(result.contractName).toBe('TestToken');
    });
  });

  describe('fetchContractAbi with legacy explorer URL', () => {
    it('should use custom explorerApi when provided', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', message: 'OK', result: SAMPLE_ABI }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', result: [{ ContractName: 'Custom' }] }), { status: 200 }));

      const { fetchContractAbi } = await import('../../modules/chain/src/etherscan.js');
      const result = await fetchContractAbi('https://api.basescan.org/api', '0xbeef', { apiKey: 'bk' });

      const [url] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('api.basescan.org');
      expect(result.contractName).toBe('Custom');
    });
  });

  describe('contract verification errors', () => {
    it('should throw when contract is not verified (NOTOK)', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        status: '0', message: 'NOTOK', result: 'Contract source code not verified',
      }), { status: 200 }));

      const { fetchContractAbi } = await import('../../modules/chain/src/etherscan.js');
      await expect(fetchContractAbi('', '0xbad', { chainId: 1 })).rejects.toThrow('Contract source code not verified');
    });
  });

  describe('rate limiting and retries', () => {
    it('should retry on 500 server errors with exponential backoff', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', message: 'OK', result: SAMPLE_ABI }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', result: [{}] }), { status: 200 }));

      const { fetchContractAbi } = await import('../../modules/chain/src/etherscan.js');
      const result = await fetchContractAbi('', '0xretry', { chainId: 1 });

      // First call fails (500), second succeeds (getabi), third is getsourcecode
      expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.abi).toHaveLength(1);
    });

    it('should throw after exhausting retry attempts on persistent 500', async () => {
      fetchSpy.mockResolvedValue(new Response('Server Error', { status: 500 }));

      const { fetchContractAbi } = await import('../../modules/chain/src/etherscan.js');
      await expect(fetchContractAbi('', '0xfail', { chainId: 1 })).rejects.toThrow();
    });
  });

  describe('storage layout extraction', () => {
    it('should parse storage layout from getsourcecode when available', async () => {
      const storageLayout = JSON.stringify({ storage: [{ label: 'owner', slot: '0', type: 'address', offset: 0 }] });
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', message: 'OK', result: SAMPLE_ABI }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', result: [{ ContractName: 'WithLayout', StorageLayout: storageLayout }] }), { status: 200 }));

      const { fetchContractAbi } = await import('../../modules/chain/src/etherscan.js');
      const result = await fetchContractAbi('', '0xlayout', { chainId: 1 });
      expect(result.storageLayout).not.toBeNull();
      expect(result.storageLayout!.storage[0].label).toBe('owner');
    });
  });
});
