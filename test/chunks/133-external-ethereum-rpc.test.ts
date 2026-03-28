/**
 * Chunk 133 — External Ethereum JSON-RPC integration tests.
 * Mocks globalThis.fetch to test RPC request construction,
 * response parsing, error handling, retry logic, and node failover.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('@sentinel/shared/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../modules/chain/src/rpc-usage.js', () => ({
  trackRpcCall: vi.fn(),
}));

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

function jsonRpcOk(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
}

function jsonRpcError(code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), { status: 200 });
}

describe('Chunk 133 — Ethereum RPC integration', () => {
  describe('eth_getBalance', () => {
    it('should send correct JSON-RPC body and parse hex result', async () => {
      fetchMock.mockResolvedValueOnce(jsonRpcOk('0xde0b6b3a7640000')); // 1 ETH

      const { createRpcClient } = await import('../../modules/chain/src/rpc.js');
      const client = createRpcClient(['https://rpc.example.com'], 1, { maxRetries: 0, retryDelayMs: 0, timeoutMs: 5000 });
      const balance = await client.getBalance('0xabc');

      expect(balance).toBe(1000000000000000000n);
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.method).toBe('eth_getBalance');
      expect(body.params).toEqual(['0xabc', 'latest']);
    });
  });

  describe('eth_getLogs', () => {
    it('should encode block range as hex and parse log entries', async () => {
      fetchMock.mockResolvedValueOnce(jsonRpcOk([
        { address: '0xtoken', topics: ['0xddf2'], data: '0x01', blockNumber: '0xa', transactionHash: '0xabc', logIndex: '0x0', transactionIndex: '0x0' },
      ]));

      const { createRpcClient } = await import('../../modules/chain/src/rpc.js');
      const client = createRpcClient(['https://rpc.example.com'], 1, { maxRetries: 0, retryDelayMs: 0, timeoutMs: 5000 });
      const logs = await client.getLogs({ fromBlock: 100n, toBlock: 200n });

      expect(logs).toHaveLength(1);
      expect(logs[0].address).toBe('0xtoken');
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.params[0].fromBlock).toBe('0x64');
      expect(body.params[0].toBlock).toBe('0xc8');
    });
  });

  describe('eth_getStorageAt', () => {
    it('should request storage slot at latest block', async () => {
      fetchMock.mockResolvedValueOnce(jsonRpcOk('0x0000000000000000000000000000000000000000000000000000000000000001'));

      const { createRpcClient } = await import('../../modules/chain/src/rpc.js');
      const client = createRpcClient(['https://rpc.example.com'], 1, { maxRetries: 0, retryDelayMs: 0, timeoutMs: 5000 });
      const val = await client.getStorageAt('0xcontract', '0x0');

      expect(val).toContain('0x');
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.method).toBe('eth_getStorageAt');
      expect(body.params).toEqual(['0xcontract', '0x0', 'latest']);
    });
  });

  describe('JSON-RPC error handling', () => {
    it('should throw on JSON-RPC error response after exhausting retries', async () => {
      fetchMock.mockResolvedValue(jsonRpcError(-32000, 'execution reverted'));

      const { createRpcClient } = await import('../../modules/chain/src/rpc.js');
      const client = createRpcClient(['https://rpc.example.com'], 1, { maxRetries: 0, retryDelayMs: 0, timeoutMs: 5000 });
      await expect(client.getBalance('0xabc')).rejects.toThrow('execution reverted');
    });
  });

  describe('retry logic with exponential backoff', () => {
    it('should retry on HTTP 500 and succeed on second attempt', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
        .mockResolvedValueOnce(jsonRpcOk('0x1'));

      const { createRpcClient } = await import('../../modules/chain/src/rpc.js');
      const client = createRpcClient(['https://rpc.example.com'], 1, { maxRetries: 1, retryDelayMs: 0, timeoutMs: 5000 });
      const bn = await client.getBlockNumber();
      expect(bn).toBe(1n);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('node failover', () => {
    it('should try second URL when first fails', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(jsonRpcOk('0x5'));

      const { createRpcClient } = await import('../../modules/chain/src/rpc.js');
      const client = createRpcClient(
        ['https://rpc1.example.com', 'https://rpc2.example.com'],
        1,
        { maxRetries: 0, retryDelayMs: 0, timeoutMs: 5000 },
      );
      const bn = await client.getBlockNumber();
      expect(bn).toBe(5n);
    });
  });
});
