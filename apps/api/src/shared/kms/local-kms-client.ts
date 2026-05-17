/**
 * LocalKmsClient — in-process KMS for local development and CI.
 *
 * WARNING: NEVER USE IN PRODUCTION.
 *   • KEK is derived from KMS_DEV_SECRET via HKDF-SHA-256. Lives in process
 *     memory; never sent to a remote service. Compromised process or leaked
 *     secret exposes all DEKs wrapped by this client.
 *   • scheduleKeyDeletion + disableKey are no-ops (logged warnings only).
 *   • No audit trail, no IAM, no CloudTrail equivalent.
 *
 * Bootstrap guard:
 *   if (process.env.NODE_ENV === 'production') throw …
 *   const kms = new LocalKmsClient();
 *
 * KEK derivation (deterministic across restarts — matches AWS KMS behaviour):
 *   KEK = HKDF-SHA-256(KMS_DEV_SECRET, salt: empty, info: 'eazepay-local-kek', 32 bytes)
 *
 * DEK wrap format:
 *   [iv:12][authTag:16][ciphertext:32] = 60 bytes (for a 32-byte plaintext DEK)
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getLogger } from '../../config/logger.js';
import type { GeneratedDataKey, KmsClient } from './kms-client.interface.js';

export const LOCAL_DEV_KEY_ID = 'local-dev';

const HKDF_INFO = Buffer.from('eazepay-local-kek', 'utf8');
const IV_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;
const WRAPPED_LEN = IV_LEN + TAG_LEN + DEK_LEN;

export class LocalKmsClient implements KmsClient {
  private readonly kek: Buffer;

  /**
   * Hard-coded property surfaced via the KmsClient interface so callers
   * (`cryptoshredOrg` in particular) can assert they are NOT running against
   * the dev client before mutating durable state. The AWS-backed client sets
   * this to true; this one is always false.
   */
  readonly isProductionGrade = false as const;

  /** @throws If NODE_ENV is 'production' (cannot use dev KMS in prod) or KMS_DEV_SECRET is unset / shorter than 32 chars. */
  constructor() {
    // P0 security guard (SEC-108): refuse to construct in production. A
    // misconfigured deploy with AWS_KMS_KEY_ARN unset must not silently fall
    // through to a deterministic HKDF-derived key. PII encrypted under this
    // key is recoverable by anyone with read access to process.env.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'LocalKmsClient cannot be used in production. Set AWS_KMS_KEY_ARN and KMS_DRIVER=aws.',
      );
    }
    const secret = process.env.KMS_DEV_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error(
        'LocalKmsClient: KMS_DEV_SECRET must be set and ≥32 chars. See .env.example. Never use a production value here.',
      );
    }
    const ikm = Buffer.from(secret, 'utf8');
    this.kek = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, DEK_LEN));
  }

  async generateDataKey(_kekKeyId: string): Promise<GeneratedDataKey> {
    const plaintext = randomBytes(DEK_LEN);
    const ciphertext = this.wrapDek(plaintext);
    return { plaintext, ciphertext };
  }

  async wrapDataKey(plaintextDek: Buffer, _kekKeyId: string): Promise<Buffer> {
    if (plaintextDek.length !== DEK_LEN) {
      throw new Error(
        `LocalKmsClient.wrapDataKey: plaintextDek must be ${DEK_LEN} bytes, got ${plaintextDek.length}`,
      );
    }
    return this.wrapDek(plaintextDek);
  }

  async unwrapDataKey(wrappedDek: Buffer, _kekKeyId: string): Promise<Buffer> {
    if (wrappedDek.length !== WRAPPED_LEN) {
      throw new Error(
        `LocalKmsClient.unwrapDataKey: wrapped DEK must be ${WRAPPED_LEN} bytes, got ${wrappedDek.length}`,
      );
    }
    return this.unwrapDek(wrappedDek);
  }

  async scheduleKeyDeletion(kekKeyId: string, pendingDays: number): Promise<void> {
    getLogger().warn(
      { kekKeyId, pendingDays },
      'LocalKmsClient.scheduleKeyDeletion no-op in dev — would destroy key material in production',
    );
  }

  async disableKey(kekKeyId: string): Promise<void> {
    getLogger().warn(
      { kekKeyId },
      'LocalKmsClient.disableKey no-op in dev — would make all ciphertext unreadable in production',
    );
  }

  private wrapDek(plaintext: Buffer): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  }

  private unwrapDek(wrapped: Buffer): Buffer {
    const iv = wrapped.subarray(0, IV_LEN);
    const tag = wrapped.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = wrapped.subarray(IV_LEN + TAG_LEN);
    // SEC: explicit authTagLength enforces our 16-byte invariant. Without it
    // Node's AES-GCM accepts tags as short as 4 bytes (RFC 5116 §5.2 minimum),
    // which weakens forgery resistance from 2^128 to 2^32 — an attacker who
    // controls the ciphertext envelope could submit a truncated tag and slip
    // past the auth check. CWE-310 / OWASP A02:2021 Cryptographic Failures.
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}
