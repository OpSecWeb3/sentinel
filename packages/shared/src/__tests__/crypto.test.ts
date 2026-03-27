import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock the env module so we control ENCRYPTION_KEY without real env vars
// ---------------------------------------------------------------------------
const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); // 64 hex chars

vi.mock('../env.js', () => ({
  env: () => ({
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  }),
}));

// Import AFTER mock registration
import { encrypt, decrypt, generateApiKey, hmacSign, timingSafeEqual } from '../crypto.js';

// ---------------------------------------------------------------------------
// encrypt / decrypt
// ---------------------------------------------------------------------------
describe('encrypt / decrypt', () => {
  it('round-trips: decrypt(encrypt(plaintext)) === plaintext', () => {
    const plaintext = 'hello world! special chars: $$%^&*(){}';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('handles empty string', () => {
    const ciphertext = encrypt('');
    expect(decrypt(ciphertext)).toBe('');
  });

  it('handles unicode / emoji', () => {
    const plaintext = 'sentinel unicode test ';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('handles very long plaintext', () => {
    const plaintext = 'a'.repeat(10_000);
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('different plaintexts produce different ciphertexts', () => {
    const ct1 = encrypt('message-one');
    const ct2 = encrypt('message-two');
    expect(ct1).not.toBe(ct2);
  });

  it('same plaintext produces different ciphertexts (random IV)', () => {
    const ct1 = encrypt('identical');
    const ct2 = encrypt('identical');
    expect(ct1).not.toBe(ct2);
  });

  it('tampered ciphertext fails to decrypt (flipped byte)', () => {
    const ciphertext = encrypt('secret data');
    const buf = Buffer.from(ciphertext, 'base64');
    // Flip a byte in the middle of the ciphertext
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('tampered auth tag fails to decrypt', () => {
    const ciphertext = encrypt('secret data');
    const buf = Buffer.from(ciphertext, 'base64');
    // Corrupt the last byte (part of the auth tag)
    buf[buf.length - 1] ^= 0x01;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('truncated ciphertext fails to decrypt', () => {
    const ciphertext = encrypt('secret data');
    const buf = Buffer.from(ciphertext, 'base64');
    const truncated = buf.subarray(0, 10).toString('base64');
    expect(() => decrypt(truncated)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateApiKey
// ---------------------------------------------------------------------------
describe('generateApiKey', () => {
  it('returns raw key with default "sk_" prefix', () => {
    const { raw, prefix, hash } = generateApiKey();
    expect(raw).toMatch(/^sk_/);
    expect(prefix).toBe(raw.slice(0, 3 + 8)); // "sk_" + 8 chars
  });

  it('hash matches SHA-256 of raw key', () => {
    const { raw, hash } = generateApiKey();
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    expect(hash).toBe(expected);
  });

  it('supports custom prefix', () => {
    const { raw, prefix, hash } = generateApiKey('pat_');
    expect(raw).toMatch(/^pat_/);
    expect(prefix).toBe(raw.slice(0, 4 + 8)); // "pat_" + 8 chars
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    expect(hash).toBe(expected);
  });

  it('generates unique keys each call', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1.raw).not.toBe(k2.raw);
    expect(k1.hash).not.toBe(k2.hash);
  });

  it('raw key is long enough to be secure (>= 32 random bytes base64url)', () => {
    const { raw } = generateApiKey();
    // 3 chars prefix + 43 chars base64url(32 bytes) = 46
    expect(raw.length).toBeGreaterThanOrEqual(46);
  });
});

// ---------------------------------------------------------------------------
// hmacSign
// ---------------------------------------------------------------------------
describe('hmacSign', () => {
  it('produces consistent signatures for same input', () => {
    const sig1 = hmacSign('payload', 'secret');
    const sig2 = hmacSign('payload', 'secret');
    expect(sig1).toBe(sig2);
  });

  it('produces hex string of correct length (64 hex chars for SHA-256)', () => {
    const sig = hmacSign('test', 'secret');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different payloads produce different signatures', () => {
    const sig1 = hmacSign('payload-a', 'secret');
    const sig2 = hmacSign('payload-b', 'secret');
    expect(sig1).not.toBe(sig2);
  });

  it('different secrets produce different signatures', () => {
    const sig1 = hmacSign('payload', 'secret-a');
    const sig2 = hmacSign('payload', 'secret-b');
    expect(sig1).not.toBe(sig2);
  });

  it('matches manual crypto.createHmac computation', () => {
    const payload = '{"event":"test"}';
    const secret = 'my-webhook-secret';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    expect(hmacSign(payload, secret)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// timingSafeEqual
// ---------------------------------------------------------------------------
describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns true for empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
  });

  it('returns false when one string is empty', () => {
    expect(timingSafeEqual('', 'notempty')).toBe(false);
  });

  it('handles long strings', () => {
    const a = 'x'.repeat(10_000);
    const b = 'x'.repeat(10_000);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it('detects single character difference in long strings', () => {
    const a = 'x'.repeat(9_999) + 'a';
    const b = 'x'.repeat(9_999) + 'b';
    expect(timingSafeEqual(a, b)).toBe(false);
  });
});
