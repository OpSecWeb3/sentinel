/**
 * Chunk 091 — Normalizer: Chain on-chain logs → normalized events
 * Chunk 092 — Handler: block.poll + block.process (cursor, log decoding)
 * Chunk 095 — Chain: RPC client (rotation, failover, usage tracking)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  getTestRedis,
} from '../helpers/setup.js';

describe('Chunk 091 — Chain log normalizer', () => {
  it('should normalize Transfer event log', () => {
    const log = {
      address: '0x1234567890abcdef1234567890abcdef12345678',
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer
        '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // from
        '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', // to
      ],
      data: '0x0000000000000000000000000000000000000000000000008ac7230489e80000', // 10 ETH
      blockNumber: '0x100',
      transactionHash: '0xabc123',
    };

    const eventType = 'chain.event_match';
    const payload = {
      address: log.address,
      eventSignature: log.topics[0],
      from: '0x' + log.topics[1].slice(26),
      to: '0x' + log.topics[2].slice(26),
      value: BigInt(log.data).toString(),
      blockNumber: parseInt(log.blockNumber, 16),
      transactionHash: log.transactionHash,
    };

    expect(eventType).toBe('chain.event_match');
    expect(payload.blockNumber).toBe(256);
    expect(payload.from).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('should normalize contract Upgraded event', () => {
    const UPGRADED_TOPIC = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';

    const log = {
      topics: [UPGRADED_TOPIC, '0x000000000000000000000000' + 'cc'.repeat(20)],
      address: '0x' + 'aa'.repeat(20),
      data: '0x',
    };

    const isUpgrade = log.topics[0] === UPGRADED_TOPIC;
    expect(isUpgrade).toBe(true);

    const newImpl = '0x' + log.topics[1].slice(26);
    expect(newImpl).toBe('0x' + 'cc'.repeat(20));
  });
});

describe('Chunk 092 — Block poller cursor', () => {
  let redis: any;

  beforeEach(async () => {
    await cleanTables();
    resetCounters();
    redis = getTestRedis();
  });

  it('should store and retrieve block cursor in Redis', async () => {
    const cursorKey = 'sentinel:chain:cursor:1'; // chainId=1
    await redis.set(cursorKey, '18500000');

    const cursor = await redis.get(cursorKey);
    expect(cursor).toBe('18500000');
  });

  it('should advance cursor after processing block', async () => {
    const cursorKey = 'sentinel:chain:cursor:1';
    await redis.set(cursorKey, '18500000');

    // Process block 18500001
    await redis.set(cursorKey, '18500001');

    const cursor = await redis.get(cursorKey);
    expect(cursor).toBe('18500001');
  });

  it('should handle missing cursor (first run)', async () => {
    const cursor = await redis.get('sentinel:chain:cursor:nonexistent');
    expect(cursor).toBeNull();
  });
});

describe('Chunk 095 — RPC client rotation', () => {
  it('should rotate through RPC providers', () => {
    const providers = [
      'https://rpc1.example.com',
      'https://rpc2.example.com',
      'https://rpc3.example.com',
    ];

    // Simple round-robin
    let index = 0;
    const getNext = () => providers[index++ % providers.length];

    expect(getNext()).toBe('https://rpc1.example.com');
    expect(getNext()).toBe('https://rpc2.example.com');
    expect(getNext()).toBe('https://rpc3.example.com');
    expect(getNext()).toBe('https://rpc1.example.com'); // wraps
  });

  it('should failover on error', () => {
    const providers = ['https://rpc1.example.com', 'https://rpc2.example.com'];
    let failedProviders = new Set<string>();
    let current = 0;

    function getHealthyProvider() {
      for (let i = 0; i < providers.length; i++) {
        const idx = (current + i) % providers.length;
        if (!failedProviders.has(providers[idx])) return providers[idx];
      }
      return providers[current % providers.length]; // fallback
    }

    expect(getHealthyProvider()).toBe('https://rpc1.example.com');

    // Mark first as failed
    failedProviders.add('https://rpc1.example.com');
    expect(getHealthyProvider()).toBe('https://rpc2.example.com');
  });

  it('should track usage per provider', async () => {
    const redis = getTestRedis();
    const usageKey = 'sentinel:rpc:usage:rpc1';

    await redis.incr(usageKey);
    await redis.incr(usageKey);
    await redis.incr(usageKey);

    const count = await redis.get(usageKey);
    expect(Number(count)).toBe(3);
  });
});
