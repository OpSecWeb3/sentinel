import crypto from 'node:crypto';
import { env } from './env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION_1 = 0x01;
// Minimum versioned buffer length: version(1) + IV(12) + authTag(16) = 29
const MIN_VERSIONED_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

function getKey(): Buffer {
  return Buffer.from(env().ENCRYPTION_KEY, 'hex');
}

function getPrevKey(): Buffer | undefined {
  const prev = env().ENCRYPTION_KEY_PREV;
  return prev ? Buffer.from(prev, 'hex') : undefined;
}

function encryptWithKey(plaintext: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

function decryptRaw(packed: Buffer, key: Buffer): string {
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(packed.length - TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Returns true when the ENCRYPTION_KEY_PREV env var is set, meaning a key
 * rotation is in progress and encrypted values may need re-encryption.
 * Handlers can use this to short-circuit expensive full-table scans when
 * no rotation is active.
 */
export function isKeyRotationActive(): boolean {
  return getPrevKey() !== undefined;
}

/**
 * Check whether a ciphertext needs re-encryption.
 * Returns true if the value is legacy (no version byte) or cannot be
 * decrypted with the current primary key (i.e. only works with PREV key).
 */
export function needsReEncrypt(ciphertext: string): boolean {
  const buf = Buffer.from(ciphertext, 'base64');

  // Legacy format (no version byte) always needs re-encryption
  if (buf.length < MIN_VERSIONED_LENGTH || buf[0] !== VERSION_1) return true;

  // Versioned — try decrypting with the current key only
  try {
    decryptRaw(buf.subarray(1), getKey());
    return false;
  } catch {
    return true;
  }
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns base64 string: version(1) + iv(12) + ciphertext + authTag(16)
 */
export function encrypt(plaintext: string): string {
  const raw = encryptWithKey(plaintext, getKey());
  return Buffer.concat([Buffer.from([VERSION_1]), raw]).toString('base64');
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * Supports versioned format (version byte prefix) and legacy format (no prefix).
 * During key rotation, falls back to ENCRYPTION_KEY_PREV when the primary key fails.
 */
export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const key = getKey();
  const prevKey = getPrevKey();

  // Versioned format: first byte is VERSION_1
  if (buf.length >= MIN_VERSIONED_LENGTH && buf[0] === VERSION_1) {
    const payload = buf.subarray(1);
    try {
      return decryptRaw(payload, key);
    } catch {
      // Fall back to previous key during rotation
      if (prevKey) {
        return decryptRaw(payload, prevKey);
      }
      throw new Error('Decryption failed');
    }
  }

  // Legacy format (no version byte): try current key, then previous key
  try {
    return decryptRaw(buf, key);
  } catch {
    if (prevKey) {
      return decryptRaw(buf, prevKey);
    }
    throw new Error('Decryption failed');
  }
}

/**
 * Generate an API key with prefix, hash, and raw value.
 */
export function generateApiKey(prefix = 'sk_'): { raw: string; prefix: string; hash: string } {
  const raw = prefix + crypto.randomBytes(32).toString('base64url');
  const keyPrefix = raw.slice(0, prefix.length + 8);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, prefix: keyPrefix, hash };
}

/**
 * Generate an org invite secret.
 * Returns:
 *   raw       — plaintext for one-time display to the admin (never stored)
 *   hash      — SHA-256 hex digest for fast DB lookup (stored in invite_secret_hash)
 *   encrypted — AES-256-GCM ciphertext for admin retrieval (stored in invite_secret_encrypted)
 */
export function generateInviteSecret(): { raw: string; hash: string; encrypted: string } {
  const raw = crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const encrypted = encrypt(raw);
  return { raw, hash, encrypted };
}

/**
 * Hash an invite secret submitted by a joining user for DB lookup.
 */
export function hashInviteSecret(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate a unique external ID for AWS cross-account assume-role trust policies.
 * Format: sentinel:{orgId}:{48 hex chars from 24 random bytes}
 */
export function generateExternalId(orgId: string): string {
  return `sentinel:${orgId}:${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * HMAC-SHA256 sign a payload.
 */
export function hmacSign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Timing-safe comparison of two strings.
 *
 * Both inputs are hashed with SHA-256 before comparison so that
 * (1) the buffers are always equal length (32 bytes) and
 * (2) we never leak the secret's length via an early return.
 * This is the same approach used by Django, Rails, and other frameworks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
