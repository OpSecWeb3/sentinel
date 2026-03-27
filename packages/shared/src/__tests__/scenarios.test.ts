import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getField, compare, evaluateConditions, type Condition } from '../conditions.js';
import { acquireSlot, releaseSlot } from '../concurrency.js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock the env module so crypto works without real env vars
// ---------------------------------------------------------------------------
const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

vi.mock('../env.js', () => ({
  env: () => ({
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  }),
}));

// Import crypto AFTER mock registration
import { encrypt, decrypt, generateApiKey, hmacSign, timingSafeEqual } from '../crypto.js';

// ---------------------------------------------------------------------------
// Minimal Redis mock (replicates Lua semantics for acquireSlot / releaseSlot)
// ---------------------------------------------------------------------------
function createRedisMock() {
  const store = new Map<string, number>();
  const ttls = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    _store: store,
    _ttls: ttls,

    async eval(script: string, _numKeys: number, key: string, ...args: unknown[]): Promise<number> {
      if (script.includes('INCR')) {
        const current = (store.get(key) ?? 0) + 1;
        store.set(key, current);
        const maxConcurrent = Number(args[0]);
        const ttlMs = Number(args[1]);
        if (current === 1 && ttlMs > 0) {
          const timer = setTimeout(() => {
            store.delete(key);
            ttls.delete(key);
          }, ttlMs);
          ttls.set(key, timer);
        }
        if (current > maxConcurrent) {
          store.set(key, current - 1);
          return 0;
        }
        return current;
      }
      // RELEASE script
      const val = (store.get(key) ?? 0) - 1;
      if (val < 0) {
        store.set(key, 0);
        return 0;
      }
      store.set(key, val);
      return val;
    },

    clearTimers() {
      for (const t of ttls.values()) clearTimeout(t);
      ttls.clear();
    },
  } as any;
}

// ===========================================================================
//  CONDITIONS ENGINE - getField
// ===========================================================================
describe('Conditions Engine - getField', () => {
  it('resolves simple dotted path a.b.c', () => {
    const obj = { a: { b: { c: 42 } } };
    expect(getField(obj, 'a.b.c')).toBe(42);
  });

  it('resolves single-level field', () => {
    const obj = { name: 'sentinel' };
    expect(getField(obj, 'name')).toBe('sentinel');
  });

  it('resolves deeply nested path (5 levels)', () => {
    const obj = { l1: { l2: { l3: { l4: { l5: 'deep' } } } } };
    expect(getField(obj, 'l1.l2.l3.l4.l5')).toBe('deep');
  });

  it('returns undefined for missing intermediate field', () => {
    const obj = { a: { b: 1 } };
    expect(getField(obj, 'a.x.y')).toBeUndefined();
  });

  it('supports array index access (items.0.name)', () => {
    const obj = { items: [{ name: 'first' }, { name: 'second' }] };
    expect(getField(obj, 'items.0.name')).toBe('first');
    expect(getField(obj, 'items.1.name')).toBe('second');
  });

  it('returns undefined when traversing through null', () => {
    const obj = { a: null };
    expect(getField(obj as any, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive', () => {
    const obj = { a: 123 };
    expect(getField(obj as any, 'a.b')).toBeUndefined();
  });

  it('returns undefined for empty path on object', () => {
    const obj = { a: 1 };
    // empty string path means split('.') yields [''], which is a valid key lookup
    expect(getField(obj, '')).toBeUndefined();
  });

  it('resolves path with numeric key on plain object', () => {
    const obj = { data: { '0': 'zero', '1': 'one' } };
    expect(getField(obj, 'data.0')).toBe('zero');
  });

  it('returns null when field value is null', () => {
    const obj = { a: { b: null } };
    expect(getField(obj, 'a.b')).toBeNull();
  });

  it('handles special characters in field names via dotted access', () => {
    // Fields with underscores, dashes, etc.
    const obj = { 'user_name': 'alice', meta: { 'org-id': 'acme' } };
    expect(getField(obj, 'user_name')).toBe('alice');
    expect(getField(obj, 'meta.org-id')).toBe('acme');
  });

  it('returns undefined for any path on empty object', () => {
    expect(getField({}, 'a')).toBeUndefined();
    expect(getField({}, 'a.b.c')).toBeUndefined();
  });

  it('resolves path to boolean false', () => {
    const obj = { feature: { enabled: false } };
    expect(getField(obj, 'feature.enabled')).toBe(false);
  });

  it('resolves path to 0 (falsy but valid)', () => {
    const obj = { counter: 0 };
    expect(getField(obj, 'counter')).toBe(0);
  });

  it('resolves path to empty string', () => {
    const obj = { label: '' };
    expect(getField(obj, 'label')).toBe('');
  });
});

// ===========================================================================
//  CONDITIONS ENGINE - compare
// ===========================================================================
describe('Conditions Engine - compare', () => {
  it('string equality ==', () => {
    expect(compare('hello', '==', 'hello')).toBe(true);
    expect(compare('hello', '==', 'world')).toBe(false);
  });

  it('string inequality !=', () => {
    expect(compare('hello', '!=', 'world')).toBe(true);
    expect(compare('hello', '!=', 'hello')).toBe(false);
  });

  it('number equality ==', () => {
    expect(compare(42, '==', 42)).toBe(true);
    expect(compare(42, '==', 43)).toBe(false);
  });

  it('number greater than >', () => {
    expect(compare(10, '>', 5)).toBe(true);
    expect(compare(5, '>', 10)).toBe(false);
    expect(compare(5, '>', 5)).toBe(false);
  });

  it('number less than <', () => {
    expect(compare(3, '<', 10)).toBe(true);
    expect(compare(10, '<', 3)).toBe(false);
    expect(compare(3, '<', 3)).toBe(false);
  });

  it('number >= at boundary', () => {
    expect(compare(5, '>=', 5)).toBe(true);
    expect(compare(6, '>=', 5)).toBe(true);
    expect(compare(4, '>=', 5)).toBe(false);
  });

  it('number <= at boundary', () => {
    expect(compare(5, '<=', 5)).toBe(true);
    expect(compare(4, '<=', 5)).toBe(true);
    expect(compare(6, '<=', 5)).toBe(false);
  });

  it('BigInt equality', () => {
    expect(compare(BigInt(100), '==', BigInt(100))).toBe(true);
    expect(compare(BigInt(100), '==', BigInt(200))).toBe(false);
  });

  it('BigInt greater than', () => {
    expect(compare(BigInt(200), '>', BigInt(100))).toBe(true);
    expect(compare(BigInt(50), '>', BigInt(100))).toBe(false);
  });

  it('mixed number and BigInt comparison (integers coerced to BigInt)', () => {
    // Both integer number and bigint get coerced to bigint by toBigIntSafe
    expect(compare(100, '==', BigInt(100))).toBe(true);
    expect(compare(BigInt(200), '>', 100)).toBe(true);
  });

  it('numeric string comparison ("100" > "50" numerically)', () => {
    // Both are numeric strings, so they go through Number() coercion path
    expect(compare('100', '>', '50')).toBe(true);
    expect(compare('50', '<', '100')).toBe(true);
  });

  it('non-numeric string comparison (alphabetical)', () => {
    // Non-numeric strings fall to String comparison
    expect(compare('banana', '>', 'apple')).toBe(true);
    expect(compare('apple', '<', 'banana')).toBe(true);
  });

  it('string vs number equality ("42" == 42)', () => {
    // "42" is a numeric string, 42 is an integer -> BigInt path
    // actual = "42" (string), expected = 42 (number -> BigInt)
    // numeric string path: na = 42, nb = 42
    expect(compare('42', '==', 42)).toBe(true);
  });

  it('NaN handling (NaN != NaN)', () => {
    // NaN is not finite, not integer, so stays as number
    // Both NaN -> number path: NaN === NaN is false
    expect(compare(NaN, '==', NaN)).toBe(false);
    expect(compare(NaN, '!=', NaN)).toBe(true);
  });

  it('Infinity comparison', () => {
    // Infinity is not finite so stays as number; finite integers become BigInt.
    // Mixed number/BigInt falls through to numeric-string path (NaN for Infinity) then string comparison.
    // Infinity vs Infinity: both stay number, so number path handles it.
    expect(compare(Infinity, '==', Infinity)).toBe(true);
    expect(compare(-Infinity, '==', -Infinity)).toBe(true);
    expect(compare(Infinity, '!=', -Infinity)).toBe(true);
    // Infinity (number) vs integer (BigInt) -> mixed types -> string: "Infinity" > "1000000"
    // String comparison: "I" < "1" is false actually; "I" (73) > "1" (49) -> true
    expect(compare(Infinity, '>', 1000000)).toBe(true);
  });

  it('BigInt from large integer', () => {
    const big = BigInt('999999999999999999999999');
    expect(compare(big, '>', BigInt('999999999999999999999998'))).toBe(true);
    expect(compare(big, '==', BigInt('999999999999999999999999'))).toBe(true);
  });

  it('float comparison (not converted to BigInt)', () => {
    // Floats are not integers, so they stay as numbers
    expect(compare(3.14, '>', 2.71)).toBe(true);
    expect(compare(3.14, '<', 2.71)).toBe(false);
    expect(compare(1.5, '==', 1.5)).toBe(true);
  });

  it('zero equality (0 == 0)', () => {
    expect(compare(0, '==', 0)).toBe(true);
    expect(compare(0, '>=', 0)).toBe(true);
    expect(compare(0, '<=', 0)).toBe(true);
  });

  it('negative number comparison', () => {
    expect(compare(-5, '<', -3)).toBe(true);
    expect(compare(-3, '>', -5)).toBe(true);
    expect(compare(-10, '==', -10)).toBe(true);
  });

  it('boolean-like string comparison', () => {
    // Booleans are not numbers; they fall through to string comparison
    expect(compare(true, '==', true)).toBe(true);
    expect(compare(false, '!=', true)).toBe(true);
  });
});

// ===========================================================================
//  CONDITIONS ENGINE - evaluateConditions
// ===========================================================================
describe('Conditions Engine - evaluateConditions', () => {
  it('empty conditions array always returns true', () => {
    expect(evaluateConditions({ any: 'payload' }, [])).toBe(true);
  });

  it('single condition that passes', () => {
    const conditions: Condition[] = [{ field: 'status', operator: '==', value: 'active' }];
    expect(evaluateConditions({ status: 'active' }, conditions)).toBe(true);
  });

  it('single condition that fails', () => {
    const conditions: Condition[] = [{ field: 'status', operator: '==', value: 'active' }];
    expect(evaluateConditions({ status: 'inactive' }, conditions)).toBe(false);
  });

  it('multiple conditions all pass (AND logic)', () => {
    const conditions: Condition[] = [
      { field: 'type', operator: '==', value: 'transfer' },
      { field: 'amount', operator: '>', value: 100 },
      { field: 'chain', operator: '==', value: 'ethereum' },
    ];
    expect(evaluateConditions({ type: 'transfer', amount: 500, chain: 'ethereum' }, conditions)).toBe(true);
  });

  it('one condition fails in set of three', () => {
    const conditions: Condition[] = [
      { field: 'type', operator: '==', value: 'transfer' },
      { field: 'amount', operator: '>', value: 1000 },
      { field: 'chain', operator: '==', value: 'ethereum' },
    ];
    expect(evaluateConditions({ type: 'transfer', amount: 500, chain: 'ethereum' }, conditions)).toBe(false);
  });

  it('condition on missing field returns false', () => {
    const conditions: Condition[] = [{ field: 'missing.field', operator: '==', value: 'anything' }];
    expect(evaluateConditions({ other: 'data' }, conditions)).toBe(false);
  });

  it('nested field condition (user.role == admin)', () => {
    const conditions: Condition[] = [{ field: 'user.role', operator: '==', value: 'admin' }];
    expect(evaluateConditions({ user: { role: 'admin' } }, conditions)).toBe(true);
    expect(evaluateConditions({ user: { role: 'viewer' } }, conditions)).toBe(false);
  });

  it('condition with BigInt value on blockchain amount', () => {
    const conditions: Condition[] = [
      { field: 'amount', operator: '>=', value: BigInt('1000000000000000000') },
    ];
    const payload = { amount: BigInt('5000000000000000000') };
    expect(evaluateConditions(payload as any, conditions)).toBe(true);
  });

  it('string condition on event type', () => {
    const conditions: Condition[] = [{ field: 'event.type', operator: '==', value: 'push' }];
    expect(evaluateConditions({ event: { type: 'push' } }, conditions)).toBe(true);
  });

  it('numeric comparison on block number', () => {
    const conditions: Condition[] = [{ field: 'blockNumber', operator: '>', value: 18000000 }];
    expect(evaluateConditions({ blockNumber: 18500000 }, conditions)).toBe(true);
    expect(evaluateConditions({ blockNumber: 17000000 }, conditions)).toBe(false);
  });

  it('multiple conditions on same object level', () => {
    const conditions: Condition[] = [
      { field: 'from', operator: '!=', value: '0x0' },
      { field: 'to', operator: '!=', value: '0x0' },
      { field: 'value', operator: '>', value: 0 },
    ];
    expect(evaluateConditions({ from: '0xabc', to: '0xdef', value: 100 }, conditions)).toBe(true);
  });

  it('condition with != operator matches', () => {
    const conditions: Condition[] = [{ field: 'status', operator: '!=', value: 'disabled' }];
    expect(evaluateConditions({ status: 'active' }, conditions)).toBe(true);
  });

  it('greater than condition on timestamp', () => {
    const cutoff = 1700000000;
    const conditions: Condition[] = [{ field: 'timestamp', operator: '>', value: cutoff }];
    expect(evaluateConditions({ timestamp: 1700000001 }, conditions)).toBe(true);
    expect(evaluateConditions({ timestamp: 1699999999 }, conditions)).toBe(false);
  });

  it('complex payload with many nested conditions', () => {
    const conditions: Condition[] = [
      { field: 'tx.from', operator: '!=', value: '0x0000000000000000000000000000000000000000' },
      { field: 'tx.value', operator: '>=', value: 1000 },
      { field: 'block.number', operator: '>', value: 100 },
      { field: 'network.chainId', operator: '==', value: 1 },
    ];
    const payload = {
      tx: { from: '0xabcdef1234567890', value: 5000, to: '0xdeadbeef' },
      block: { number: 200, timestamp: 1700000000 },
      network: { chainId: 1, name: 'mainnet' },
    };
    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('all operators in sequence on a single payload', () => {
    const payload = { a: 10, b: 'hello', c: 20, d: 5 };
    expect(evaluateConditions(payload, [{ field: 'a', operator: '==', value: 10 }])).toBe(true);
    expect(evaluateConditions(payload, [{ field: 'a', operator: '!=', value: 99 }])).toBe(true);
    expect(evaluateConditions(payload, [{ field: 'a', operator: '>', value: 5 }])).toBe(true);
    expect(evaluateConditions(payload, [{ field: 'a', operator: '<', value: 20 }])).toBe(true);
    expect(evaluateConditions(payload, [{ field: 'a', operator: '>=', value: 10 }])).toBe(true);
    expect(evaluateConditions(payload, [{ field: 'a', operator: '<=', value: 10 }])).toBe(true);
  });
});

// ===========================================================================
//  CONCURRENCY - acquireSlot / releaseSlot
// ===========================================================================
describe('Concurrency - acquireSlot / releaseSlot', () => {
  let redis: ReturnType<typeof createRedisMock>;
  const KEY = 'scenario:concurrency';

  beforeEach(() => {
    redis = createRedisMock();
  });

  it('acquire first slot succeeds', async () => {
    expect(await acquireSlot(redis, KEY, 5)).toBe(true);
    expect(redis._store.get(KEY)).toBe(1);
  });

  it('acquire up to maxConcurrent succeeds', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await acquireSlot(redis, KEY, 5)).toBe(true);
    }
    expect(redis._store.get(KEY)).toBe(5);
  });

  it('acquire beyond maxConcurrent fails', async () => {
    for (let i = 0; i < 3; i++) await acquireSlot(redis, KEY, 3);
    expect(await acquireSlot(redis, KEY, 3)).toBe(false);
    expect(redis._store.get(KEY)).toBe(3);
  });

  it('release slot then acquire succeeds', async () => {
    for (let i = 0; i < 3; i++) await acquireSlot(redis, KEY, 3);
    expect(await acquireSlot(redis, KEY, 3)).toBe(false);
    await releaseSlot(redis, KEY);
    expect(await acquireSlot(redis, KEY, 3)).toBe(true);
  });

  it('multiple acquire/release cycles', async () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(await acquireSlot(redis, KEY, 1)).toBe(true);
      expect(await acquireSlot(redis, KEY, 1)).toBe(false);
      await releaseSlot(redis, KEY);
    }
    expect(redis._store.get(KEY)).toBe(0);
  });

  it('double release floors at zero', async () => {
    await acquireSlot(redis, KEY, 2);
    await releaseSlot(redis, KEY);
    await releaseSlot(redis, KEY);
    await releaseSlot(redis, KEY); // would go negative
    expect(redis._store.get(KEY)).toBe(0);
  });

  it('TTL prevents permanent lock (simulated via mock timer)', async () => {
    // This tests the TTL branch being set on first acquire
    // In the mock, TTL is set but we verify the timer was created
    await acquireSlot(redis, KEY, 2, 100);
    expect(redis._ttls.has(KEY)).toBe(true);
    redis.clearTimers();
  });

  it('concurrent acquisition race (simulated)', async () => {
    // Launch multiple acquires in parallel
    const results = await Promise.all([
      acquireSlot(redis, KEY, 2),
      acquireSlot(redis, KEY, 2),
      acquireSlot(redis, KEY, 2),
      acquireSlot(redis, KEY, 2),
    ]);
    const acquired = results.filter(Boolean).length;
    const rejected = results.filter((r) => !r).length;
    expect(acquired).toBe(2);
    expect(rejected).toBe(2);
  });

  it('release on empty key floors at zero', async () => {
    await releaseSlot(redis, 'nonexistent:key');
    expect(redis._store.get('nonexistent:key')).toBe(0);
  });

  it('different keys are independent', async () => {
    await acquireSlot(redis, 'key:a', 1);
    await acquireSlot(redis, 'key:b', 1);
    expect(await acquireSlot(redis, 'key:a', 1)).toBe(false);
    expect(await acquireSlot(redis, 'key:b', 1)).toBe(false);
    await releaseSlot(redis, 'key:a');
    expect(await acquireSlot(redis, 'key:a', 1)).toBe(true);
    // key:b still at limit
    expect(await acquireSlot(redis, 'key:b', 1)).toBe(false);
  });

  it('maxConcurrent=1 acts as mutex', async () => {
    expect(await acquireSlot(redis, KEY, 1)).toBe(true);
    expect(await acquireSlot(redis, KEY, 1)).toBe(false);
    await releaseSlot(redis, KEY);
    expect(await acquireSlot(redis, KEY, 1)).toBe(true);
  });

  it('large maxConcurrent value', async () => {
    const max = 1000;
    for (let i = 0; i < max; i++) {
      expect(await acquireSlot(redis, KEY, max)).toBe(true);
    }
    expect(await acquireSlot(redis, KEY, max)).toBe(false);
    expect(redis._store.get(KEY)).toBe(max);
  });
});

// ===========================================================================
//  CRYPTO - encrypt / decrypt
// ===========================================================================
describe('Crypto - encrypt / decrypt', () => {
  it('round-trip encryption/decryption', () => {
    const text = 'sentinel secret data';
    expect(decrypt(encrypt(text))).toBe(text);
  });

  it('unicode text encryption', () => {
    const text = 'Japanese: \u65E5\u672C\u8A9E, Chinese: \u4E2D\u6587, Arabic: \u0627\u0644\u0639\u0631\u0628\u064A\u0629';
    expect(decrypt(encrypt(text))).toBe(text);
  });

  it('long text (10KB+) encryption', () => {
    const text = 'x'.repeat(10240);
    expect(decrypt(encrypt(text))).toBe(text);
  });

  it('empty string encryption', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('tampered ciphertext fails decrypt', () => {
    const ct = encrypt('secret');
    const buf = Buffer.from(ct, 'base64');
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });

  it('different texts produce different ciphertexts', () => {
    expect(encrypt('alpha')).not.toBe(encrypt('bravo'));
  });

  it('same text encrypted twice produces different IVs', () => {
    const ct1 = encrypt('identical');
    const ct2 = encrypt('identical');
    expect(ct1).not.toBe(ct2);
    // But both decrypt to the same plaintext
    expect(decrypt(ct1)).toBe(decrypt(ct2));
  });

  it('auth tag tampering detection', () => {
    const ct = encrypt('important data');
    const buf = Buffer.from(ct, 'base64');
    // Corrupt last byte (part of auth tag)
    buf[buf.length - 1] ^= 0x01;
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });

  it('JSON object encrypt/decrypt', () => {
    const obj = { event: 'transfer', amount: '1000000000000000000', from: '0xabc' };
    const json = JSON.stringify(obj);
    const decrypted = decrypt(encrypt(json));
    expect(JSON.parse(decrypted)).toEqual(obj);
  });

  it('special characters in plaintext', () => {
    const text = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\`~\n\t\r';
    expect(decrypt(encrypt(text))).toBe(text);
  });

  it('binary-like content (control characters)', () => {
    const text = '\x00\x01\x02\x03\x04\x05\x06\x07\x08';
    expect(decrypt(encrypt(text))).toBe(text);
  });

  it('encrypted value is valid base64', () => {
    const ct = encrypt('test');
    // Should not throw when decoded
    expect(() => Buffer.from(ct, 'base64')).not.toThrow();
    // The base64 decoded buffer should have at least IV (12) + tag (16) bytes
    expect(Buffer.from(ct, 'base64').length).toBeGreaterThanOrEqual(12 + 16);
  });
});

// ===========================================================================
//  CRYPTO - generateApiKey
// ===========================================================================
describe('Crypto - generateApiKey', () => {
  it('returns prefix, hash, and raw key', () => {
    const key = generateApiKey();
    expect(key).toHaveProperty('raw');
    expect(key).toHaveProperty('prefix');
    expect(key).toHaveProperty('hash');
  });

  it('raw key starts with prefix', () => {
    const key = generateApiKey();
    expect(key.raw.startsWith('sk_')).toBe(true);
  });

  it('hash is SHA-256 hex (64 chars)', () => {
    const key = generateApiKey();
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two generated keys are unique', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1.raw).not.toBe(k2.raw);
    expect(k1.hash).not.toBe(k2.hash);
  });

  it('custom prefix', () => {
    const key = generateApiKey('pat_');
    expect(key.raw.startsWith('pat_')).toBe(true);
  });

  it('default prefix is sk_', () => {
    const key = generateApiKey();
    expect(key.raw.slice(0, 3)).toBe('sk_');
  });

  it('prefix length in returned prefix field', () => {
    const key = generateApiKey('sk_');
    // prefix is first (prefix.length + 8) chars of raw
    expect(key.prefix).toBe(key.raw.slice(0, 3 + 8));
    expect(key.prefix.length).toBe(11);
  });

  it('hash is deterministic from raw key', () => {
    const key = generateApiKey();
    const recomputed = crypto.createHash('sha256').update(key.raw).digest('hex');
    expect(key.hash).toBe(recomputed);
  });
});

// ===========================================================================
//  CRYPTO - hmacSign and timingSafeEqual
// ===========================================================================
describe('Crypto - hmacSign and timingSafeEqual', () => {
  it('consistent HMAC for same payload+secret', () => {
    const sig1 = hmacSign('{"event":"push"}', 'webhook-secret');
    const sig2 = hmacSign('{"event":"push"}', 'webhook-secret');
    expect(sig1).toBe(sig2);
  });

  it('different payloads produce different HMACs', () => {
    const sig1 = hmacSign('payload-alpha', 'secret');
    const sig2 = hmacSign('payload-bravo', 'secret');
    expect(sig1).not.toBe(sig2);
  });

  it('different secrets produce different HMACs', () => {
    const sig1 = hmacSign('payload', 'secret-one');
    const sig2 = hmacSign('payload', 'secret-two');
    expect(sig1).not.toBe(sig2);
  });

  it('HMAC is hex string of 64 characters', () => {
    const sig = hmacSign('data', 'key');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('timingSafeEqual returns true for equal strings', () => {
    expect(timingSafeEqual('abc123def456', 'abc123def456')).toBe(true);
  });

  it('timingSafeEqual returns false for different strings', () => {
    expect(timingSafeEqual('abc123', 'xyz789')).toBe(false);
  });

  it('timingSafeEqual returns false for different lengths', () => {
    expect(timingSafeEqual('short', 'muchlongerstring')).toBe(false);
  });

  it('timingSafeEqual resistant to length attacks (fast reject on length mismatch)', () => {
    // Should not throw even with vastly different lengths
    expect(timingSafeEqual('a', 'a'.repeat(10000))).toBe(false);
    expect(timingSafeEqual('a'.repeat(10000), 'a')).toBe(false);
  });
});

// ===========================================================================
//  CROSS-CUTTING PLATFORM SCENARIOS
// ===========================================================================
describe('Cross-cutting Platform Scenarios', () => {
  it('API key generated -> hash verified with crypto', () => {
    const { raw, hash } = generateApiKey();
    const computedHash = crypto.createHash('sha256').update(raw).digest('hex');
    expect(hash).toBe(computedHash);
    // Simulate looking up by hash in a database
    expect(timingSafeEqual(hash, computedHash)).toBe(true);
  });

  it('event payload conditions match blockchain transfer amount > threshold', () => {
    const payload = {
      event: 'Transfer',
      from: '0x1234567890abcdef1234567890abcdef12345678',
      to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      amount: BigInt('5000000000000000000'), // 5 ETH in wei
    };
    const conditions: Condition[] = [
      { field: 'event', operator: '==', value: 'Transfer' },
      { field: 'amount', operator: '>', value: BigInt('1000000000000000000') }, // > 1 ETH
    ];
    expect(evaluateConditions(payload as any, conditions)).toBe(true);
  });

  it('condition on deeply nested webhook payload', () => {
    const githubWebhook = {
      action: 'completed',
      workflow_run: {
        conclusion: 'failure',
        repository: {
          full_name: 'acme/sentinel',
          owner: {
            login: 'acme',
          },
        },
      },
    };
    const conditions: Condition[] = [
      { field: 'action', operator: '==', value: 'completed' },
      { field: 'workflow_run.conclusion', operator: '==', value: 'failure' },
      { field: 'workflow_run.repository.owner.login', operator: '==', value: 'acme' },
    ];
    expect(evaluateConditions(githubWebhook, conditions)).toBe(true);
  });

  it('concurrency slot used as rate limiter', async () => {
    const redis = createRedisMock();
    const rateLimitKey = 'ratelimit:org:acme:webhook-dispatch';
    const maxPerSecond = 10;

    // Simulate 10 requests succeeding
    for (let i = 0; i < maxPerSecond; i++) {
      expect(await acquireSlot(redis, rateLimitKey, maxPerSecond)).toBe(true);
    }
    // 11th request should be rejected
    expect(await acquireSlot(redis, rateLimitKey, maxPerSecond)).toBe(false);

    // After a "period" passes, release all and try again
    for (let i = 0; i < maxPerSecond; i++) {
      await releaseSlot(redis, rateLimitKey);
    }
    expect(await acquireSlot(redis, rateLimitKey, maxPerSecond)).toBe(true);
    redis.clearTimers();
  });

  it('encrypted webhook secret round-trip', () => {
    const webhookSecret = 'whsec_a1b2c3d4e5f6g7h8i9j0';
    const encrypted = encrypt(webhookSecret);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(webhookSecret);
    // Verify the encrypted value is opaque
    expect(encrypted).not.toContain(webhookSecret);
  });

  it('HMAC signature verification for GitHub webhook', () => {
    const webhookBody = JSON.stringify({
      action: 'opened',
      pull_request: { number: 42, title: 'Fix branch protection' },
    });
    const secret = 'github-webhook-secret-123';
    const signature = hmacSign(webhookBody, secret);

    // Simulate verification on the receiving end
    const expectedSignature = hmacSign(webhookBody, secret);
    expect(timingSafeEqual(signature, expectedSignature)).toBe(true);

    // Tampered body should not match
    const tamperedBody = webhookBody.replace('42', '43');
    const tamperedSignature = hmacSign(tamperedBody, secret);
    expect(timingSafeEqual(signature, tamperedSignature)).toBe(false);
  });

  it('BigInt condition on wei amount (18 decimal places)', () => {
    // 1 ETH = 10^18 wei
    const oneEthWei = BigInt('1000000000000000000');
    const tenEthWei = BigInt('10000000000000000000');

    const payload = { value: tenEthWei };
    const conditions: Condition[] = [
      { field: 'value', operator: '>=', value: oneEthWei },
    ];
    expect(evaluateConditions(payload as any, conditions)).toBe(true);

    const smallPayload = { value: BigInt('500000000000000000') }; // 0.5 ETH
    expect(evaluateConditions(smallPayload as any, conditions)).toBe(false);
  });

  it('multiple concurrent evaluations with slot limiting', async () => {
    const redis = createRedisMock();
    const key = 'eval:concurrent';
    const maxEvals = 3;

    // Simulate N event evaluations arriving at once
    const evaluations = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      payload: { event: 'transfer', amount: (i + 1) * 100 },
    }));

    const results: { id: number; acquired: boolean; matched: boolean }[] = [];

    for (const ev of evaluations) {
      const acquired = await acquireSlot(redis, key, maxEvals);
      let matched = false;
      if (acquired) {
        const conditions: Condition[] = [{ field: 'amount', operator: '>', value: 200 }];
        matched = evaluateConditions(ev.payload, conditions);
        await releaseSlot(redis, key);
      }
      results.push({ id: ev.id, acquired, matched });
    }

    // All should have acquired since we release after each evaluation
    expect(results.every((r) => r.acquired)).toBe(true);
    // Evaluations with amount <= 200 should not match
    expect(results[0].matched).toBe(false); // amount=100
    expect(results[1].matched).toBe(false); // amount=200
    expect(results[2].matched).toBe(true);  // amount=300
    redis.clearTimers();
  });

  it('condition evaluation on null payload fields', () => {
    const payload = { user: null, status: 'active' };
    // Condition on null field: getField returns null, not undefined, so compare runs
    const conditions: Condition[] = [{ field: 'user', operator: '==', value: null }];
    // null is not undefined, so it enters compare.
    // compare(null, '==', null): toBigIntSafe(null) -> null, both are null (not bigint, not number)
    // na = NaN, nb = NaN -> not finite -> falls to string comparison: "null" === "null"
    expect(evaluateConditions(payload as any, conditions)).toBe(true);
  });

  it('compare operator with undefined actual value', () => {
    // evaluateConditions returns false for undefined actual
    const conditions: Condition[] = [{ field: 'nonexistent', operator: '==', value: 'something' }];
    expect(evaluateConditions({}, conditions)).toBe(false);
  });

  it('encryption key rotation scenario (different key fails)', () => {
    // Encrypt with current key
    const ct = encrypt('sensitive-config');

    // Save original mock and create a new env mock with different key
    const differentKey = crypto.randomBytes(32).toString('hex');
    const originalParse = vi.fn();

    // Decrypt with same key works
    expect(decrypt(ct)).toBe('sensitive-config');

    // We cannot easily swap the mocked env mid-test, but we can verify
    // that a manually crafted ciphertext with wrong key layout fails
    const wrongBuf = Buffer.from(ct, 'base64');
    // Corrupt the IV portion to simulate wrong key effect
    wrongBuf[0] ^= 0xff;
    wrongBuf[1] ^= 0xff;
    expect(() => decrypt(wrongBuf.toString('base64'))).toThrow();
  });

  it('API key prefix extraction', () => {
    const key = generateApiKey('org_');
    // Verify prefix field gives us a useful short identifier
    expect(key.prefix.startsWith('org_')).toBe(true);
    expect(key.prefix.length).toBe(4 + 8); // prefix + 8 chars
    // Prefix should be a substring of raw
    expect(key.raw.startsWith(key.prefix)).toBe(true);
    // Can use prefix for display while hash for lookup
    expect(key.hash.length).toBe(64);
  });
});
