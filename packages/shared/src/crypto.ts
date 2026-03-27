import crypto from 'node:crypto';
import { env } from './env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  return Buffer.from(env().ENCRYPTION_KEY, 'hex');
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns base64 string: iv + ciphertext + authTag
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

/**
 * Decrypt AES-256-GCM ciphertext.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const packed = Buffer.from(ciphertext, 'base64');

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(packed.length - TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
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
 * HMAC-SHA256 sign a payload.
 */
export function hmacSign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Timing-safe comparison of two strings.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
