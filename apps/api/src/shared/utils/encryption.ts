import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env.js';

/**
 * AES-256-GCM PII envelope.
 *
 * Layout (single Buffer):
 *   [version:1 byte][iv:12 bytes][authTag:16 bytes][ciphertext:N bytes]
 *
 * Hash (deterministic, for searchable equality lookups):
 *   HMAC-SHA-256( PII_HASH_SECRET, normalize(plaintext) )
 *
 * Versioning: byte 0 carries a key-version tag so we can rotate keys without
 * decrypting the whole corpus. v1 = current. Future rotations register prior
 * versions in `KEY_VERSIONS` — never delete an old key while ciphertext exists.
 */

const VERSION_CURRENT = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

interface KeyVersion {
  readonly version: number;
  readonly key: Buffer;
}

let keyVersionsCache: ReadonlyMap<number, KeyVersion> | undefined;

function loadKeyVersions(): ReadonlyMap<number, KeyVersion> {
  if (keyVersionsCache) return keyVersionsCache;
  const env = getEnv();
  const current: KeyVersion = {
    version: VERSION_CURRENT,
    key: Buffer.from(env.PII_ENCRYPTION_KEY, 'base64'),
  };
  if (current.key.length !== 32) {
    throw new Error('PII_ENCRYPTION_KEY must decode to exactly 32 bytes (validated in env, defensive guard)');
  }
  keyVersionsCache = new Map([[current.version, current]]);
  return keyVersionsCache;
}

export interface EncryptedPII {
  readonly ciphertext: Buffer;
  readonly hash: Buffer;
}

function normalize(plaintext: string): string {
  return plaintext.trim().toLowerCase();
}

export function encryptPII(plaintext: string): EncryptedPII {
  const versions = loadKeyVersions();
  const current = versions.get(VERSION_CURRENT);
  if (!current) throw new Error('encryption.no_current_key');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([Buffer.from([current.version]), iv, tag, enc]);
  return { ciphertext: out, hash: hashPII(plaintext) };
}

export function decryptPII(envelope: Buffer): string {
  if (envelope.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error('encryption.envelope_too_short');
  }
  const versionByte = envelope.readUInt8(0);
  const versions = loadKeyVersions();
  const kv = versions.get(versionByte);
  if (!kv) throw new Error(`encryption.unknown_key_version:${versionByte}`);
  const iv = envelope.subarray(1, 1 + IV_LEN);
  const tag = envelope.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = envelope.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', kv.key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}

export function hashPII(plaintext: string): Buffer {
  const env = getEnv();
  return createHmac('sha256', env.PII_HASH_SECRET).update(normalize(plaintext)).digest();
}

/** Constant-time equality for hash buffers. */
export function hashesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function __resetEncryptionCacheForTests(): void {
  keyVersionsCache = undefined;
}
