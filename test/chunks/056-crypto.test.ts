/**
 * Chunk 056 — Crypto: encrypt/decrypt (AES-256-GCM, key rotation, legacy detection, needsReEncrypt)
 */
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, needsReEncrypt, generateApiKey, generateInviteSecret, hmacSign, timingSafeEqual } from '@sentinel/shared/crypto';

describe('Chunk 056 — Crypto utilities', () => {
  describe('encrypt / decrypt', () => {
    it('should encrypt and decrypt a string round-trip', () => {
      const plaintext = 'hello world secret data';
      const ciphertext = encrypt(plaintext);

      expect(ciphertext).not.toBe(plaintext);
      expect(typeof ciphertext).toBe('string');

      const decrypted = decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertexts for the same plaintext (random IV)', () => {
      const plaintext = 'same input';
      const ct1 = encrypt(plaintext);
      const ct2 = encrypt(plaintext);

      expect(ct1).not.toBe(ct2);

      // Both should decrypt to the same value
      expect(decrypt(ct1)).toBe(plaintext);
      expect(decrypt(ct2)).toBe(plaintext);
    });

    it('should handle empty string', () => {
      const ciphertext = encrypt('');
      expect(decrypt(ciphertext)).toBe('');
    });

    it('should handle unicode text', () => {
      const plaintext = 'こんにちは 🌍 héllo';
      const ciphertext = encrypt(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });

    it('should handle large payloads', () => {
      const plaintext = 'x'.repeat(100_000);
      const ciphertext = encrypt(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });

    it('should throw on corrupted ciphertext', () => {
      const ciphertext = encrypt('test');
      // Corrupt the middle of the base64 string
      const corrupted = ciphertext.slice(0, 10) + 'XXXX' + ciphertext.slice(14);
      expect(() => decrypt(corrupted)).toThrow();
    });
  });

  describe('needsReEncrypt', () => {
    it('should return false for freshly encrypted data', () => {
      const ciphertext = encrypt('test data');
      expect(needsReEncrypt(ciphertext)).toBe(false);
    });

    it('should return true for garbage data', () => {
      expect(needsReEncrypt('not-real-ciphertext')).toBe(true);
    });
  });
});

describe('Chunk 057 — Crypto: key generation & signing', () => {
  describe('generateApiKey', () => {
    it('should generate key with sk_ prefix', () => {
      const { raw, prefix, hash } = generateApiKey('sk_');
      expect(raw).toMatch(/^sk_/);
      expect(prefix).toMatch(/^sk_/);
      expect(prefix.length).toBe(11); // "sk_" + 8 chars
      expect(hash).toHaveLength(64); // SHA-256 hex
    });

    it('should generate unique keys', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1.raw).not.toBe(key2.raw);
      expect(key1.hash).not.toBe(key2.hash);
    });

    it('should generate key with custom prefix', () => {
      const { raw } = generateApiKey('snk_');
      expect(raw).toMatch(/^snk_/);
    });
  });

  describe('generateInviteSecret', () => {
    it('should return raw, hash, and encrypted', () => {
      const { raw, hash, encrypted } = generateInviteSecret();

      expect(typeof raw).toBe('string');
      expect(raw.length).toBeGreaterThan(10);
      expect(hash).toHaveLength(64); // SHA-256 hex
      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');
    });

    it('should produce encrypted value that decrypts to raw', () => {
      const { raw, encrypted } = generateInviteSecret();
      expect(decrypt(encrypted)).toBe(raw);
    });

    it('should generate unique secrets', () => {
      const s1 = generateInviteSecret();
      const s2 = generateInviteSecret();
      expect(s1.raw).not.toBe(s2.raw);
    });
  });

  describe('hmacSign', () => {
    it('should produce consistent HMAC for same input', () => {
      const sig1 = hmacSign('payload', 'secret');
      const sig2 = hmacSign('payload', 'secret');
      expect(sig1).toBe(sig2);
    });

    it('should produce different HMAC for different payloads', () => {
      const sig1 = hmacSign('payload1', 'secret');
      const sig2 = hmacSign('payload2', 'secret');
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different HMAC for different secrets', () => {
      const sig1 = hmacSign('payload', 'secret1');
      const sig2 = hmacSign('payload', 'secret2');
      expect(sig1).not.toBe(sig2);
    });

    it('should return hex string', () => {
      const sig = hmacSign('test', 'key');
      expect(sig).toMatch(/^[a-f0-9]+$/);
      expect(sig).toHaveLength(64);
    });
  });

  describe('timingSafeEqual', () => {
    it('should return true for equal strings', () => {
      expect(timingSafeEqual('abc', 'abc')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(timingSafeEqual('abc', 'def')).toBe(false);
    });

    it('should return false for different-length strings', () => {
      expect(timingSafeEqual('short', 'longer string')).toBe(false);
    });

    it('should return true for empty strings', () => {
      expect(timingSafeEqual('', '')).toBe(true);
    });
  });
});
