/**
 * KMS abstraction — KmsClient interface + GeneratedDataKey value type.
 *
 * All KMS operations in EazePay Intelligence route through this interface.
 * No application module imports an AWS SDK type or references any KMS
 * provider directly — only a KmsClient implementation. This keeps the
 * cryptographic provider swappable without touching calling code.
 *
 * Registered implementations (one active at a time, chosen at bootstrap):
 *   • LocalKmsClient — HKDF-derived in-process KEK. Dev/test only.
 *   • AwsKmsClient   — AWS KMS ap-southeast-2. Production default. (Phase 1.5)
 *
 * See ADR-002 for the full design, rotation runbook, and the RTBF Mode B
 * (org-level cryptoshred) flow that depends on disableKey + scheduleKeyDeletion.
 */

/**
 * Value returned by KmsClient.generateDataKey.
 *
 * The plaintext DEK is raw AES key material — never log it, never persist it,
 * never include it in an error message. Hold it in memory only for the
 * duration of the encrypt operation, then let GC collect it.
 *
 * The ciphertext DEK is safe to persist — it's the value stored in
 * tenant_encryption_keys.wrapped_dek. Recovering plaintext requires a live,
 * authorised call to the same KMS provider with the same KEK.
 */
export interface GeneratedDataKey {
  /** Raw 32-byte AES-256 DEK. Memory-only; never persist or log. */
  readonly plaintext: Buffer;
  /** KMS-wrapped form. Safe to persist. Useless without KMS access. */
  readonly ciphertext: Buffer;
}

/**
 * Uniform interface for Key Management Service operations.
 *
 * All methods async even for in-process implementations to keep call sites
 * provider-agnostic. Callers must never branch on whether the implementation
 * is local or remote.
 */
export interface KmsClient {
  /**
   * Generate a fresh DEK + KMS-wrapped ciphertext atomically.
   *
   * Called during DEK provisioning (first key for a new org) and at the
   * start of every key rotation. Caller must persist the ciphertext and
   * discard the plaintext after first use.
   *
   * @param kekKeyId KMS key id. AWS: key ARN. LocalKms: 'local-dev'.
   * @throws If KMS unavailable or kekKeyId invalid.
   */
  generateDataKey(kekKeyId: string): Promise<GeneratedDataKey>;

  /**
   * Wrap an existing plaintext DEK under the given KEK.
   *
   * Used when re-wrapping under a new KEK (e.g. migrating platform-wide CMK
   * to per-org CMK). Normal rotation uses generateDataKey instead.
   *
   * @throws If plaintextDek is not exactly 32 bytes, or KMS call fails.
   */
  wrapDataKey(plaintextDek: Buffer, kekKeyId: string): Promise<Buffer>;

  /**
   * Unwrap a stored ciphertext DEK back to plaintext.
   *
   * Called on read-path cache miss. Caller (DekCache) holds the result for
   * the process lifetime, TTL 1h. Never retain references beyond the
   * immediate decrypt operation — the cache owns lifetime.
   *
   * @throws If ciphertext malformed, KEK disabled/deleted, or IAM denies.
   */
  unwrapDataKey(wrappedDek: Buffer, kekKeyId: string): Promise<Buffer>;

  /**
   * Schedule deletion of a KMS key after a pending window.
   *
   * Final step of org-level RTBF Mode B (ADR-002 §9) and end of rotation
   * runbook. Once the window elapses, all wrapped DEKs become permanently
   * unrecoverable — including from backups.
   *
   * IRREVERSIBLE. Caller must confirm zero ciphertext rows reference any
   * DEK wrapped under this KEK before calling.
   *
   * @param pendingDays AWS KMS accepts 7–30. LocalKmsClient no-ops with warning.
   */
  scheduleKeyDeletion(kekKeyId: string, pendingDays: number): Promise<void>;

  /**
   * Immediately disable a KMS key, preventing further decrypts.
   *
   * Combined Mode B flow:
   *   1. disableKey(kekKeyId) — immediate unreadability
   *   2. scheduleKeyDeletion(kekKeyId, 7) — permanent destruction in 7 days
   *
   * @throws If KMS rejects the request.
   */
  disableKey(kekKeyId: string): Promise<void>;
}
