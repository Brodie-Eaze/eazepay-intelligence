/**
 * AwsKmsClient — production KMS implementation backed by AWS KMS.
 *
 * Region: ap-southeast-2 (Sydney) by default per ADR-002 §1 (AU data
 * residency). Override via AWS_REGION env var if a deployment runs
 * elsewhere. The KEK key id is supplied per-call (see KmsClient
 * interface) — this lets the same client serve a per-org-CMK strategy
 * (recommended) or a platform-wide-CMK strategy.
 *
 * Authentication:
 *   The AWS SDK auto-resolves credentials from the standard chain:
 *   environment vars → IAM instance profile → IAM role for service account.
 *   In production, the API + workers run with an IAM role that grants:
 *     kms:Encrypt, kms:Decrypt, kms:GenerateDataKey,
 *     kms:DisableKey, kms:ScheduleKeyDeletion
 *   on the relevant KMS key resources. Never use long-lived access keys
 *   in production.
 *
 * Operational notes:
 *   - Each generateDataKey/encrypt/decrypt is one round-trip to AWS KMS.
 *     The DekCache (shared/kms/dek-cache.ts) absorbs the read-path cost
 *     by caching unwrapped DEKs for 1h.
 *   - AWS KMS has a 600 ops/second per-account-per-region limit on the
 *     symmetric crypto operations (Encrypt/Decrypt/GenerateDataKey). At
 *     our envelope cache hit rate, even high write volume stays well
 *     under that limit.
 *   - Errors are wrapped with the original AWS error chained — callers
 *     see the high-level intent first ("KMS unwrap failed") and can drill
 *     into the underlying AWS code via .cause.
 *
 * NOT used in dev/test — bootstrap registers LocalKmsClient when
 * NODE_ENV !== 'production'. The kms-factory.ts module owns that branch.
 */
import {
  DisableKeyCommand,
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  ScheduleKeyDeletionCommand,
} from '@aws-sdk/client-kms';
import type { GeneratedDataKey, KmsClient } from './kms-client.interface.js';

export interface AwsKmsClientOptions {
  /** AWS region. Defaults to AWS_REGION env or 'ap-southeast-2'. */
  region?: string;
}

export class AwsKmsClient implements KmsClient {
  private readonly client: KMSClient;

  /** See KmsClient.isProductionGrade — true here; false for LocalKmsClient. */
  readonly isProductionGrade = true as const;

  constructor(opts: AwsKmsClientOptions = {}) {
    const region = opts.region ?? process.env['AWS_REGION'] ?? 'ap-southeast-2';
    this.client = new KMSClient({ region });
  }

  async generateDataKey(kekKeyId: string): Promise<GeneratedDataKey> {
    try {
      const result = await this.client.send(
        new GenerateDataKeyCommand({
          KeyId: kekKeyId,
          // AES_256 = 32 bytes plaintext + KMS-wrapped ciphertext.
          KeySpec: 'AES_256',
        }),
      );
      if (!result.Plaintext || !result.CiphertextBlob) {
        throw new Error('AwsKmsClient.generateDataKey: KMS response missing key bytes');
      }
      return {
        plaintext: Buffer.from(result.Plaintext),
        ciphertext: Buffer.from(result.CiphertextBlob),
      };
    } catch (err) {
      throw wrap(err, `KMS generateDataKey failed for kekKeyId=${kekKeyId}`);
    }
  }

  async wrapDataKey(plaintextDek: Buffer, kekKeyId: string): Promise<Buffer> {
    if (plaintextDek.length !== 32) {
      throw new Error(
        `AwsKmsClient.wrapDataKey: plaintextDek must be 32 bytes, got ${plaintextDek.length}`,
      );
    }
    try {
      const result = await this.client.send(
        new EncryptCommand({ KeyId: kekKeyId, Plaintext: plaintextDek }),
      );
      if (!result.CiphertextBlob) {
        throw new Error('AwsKmsClient.wrapDataKey: KMS response missing ciphertext');
      }
      return Buffer.from(result.CiphertextBlob);
    } catch (err) {
      throw wrap(err, `KMS Encrypt (wrap) failed for kekKeyId=${kekKeyId}`);
    }
  }

  async unwrapDataKey(wrappedDek: Buffer, kekKeyId: string): Promise<Buffer> {
    try {
      const result = await this.client.send(
        new DecryptCommand({
          CiphertextBlob: wrappedDek,
          KeyId: kekKeyId,
        }),
      );
      if (!result.Plaintext) {
        throw new Error('AwsKmsClient.unwrapDataKey: KMS response missing plaintext');
      }
      return Buffer.from(result.Plaintext);
    } catch (err) {
      throw wrap(err, `KMS Decrypt (unwrap) failed for kekKeyId=${kekKeyId}`);
    }
  }

  async scheduleKeyDeletion(kekKeyId: string, pendingDays: number): Promise<void> {
    if (pendingDays < 7 || pendingDays > 30) {
      throw new Error(
        `AwsKmsClient.scheduleKeyDeletion: pendingDays must be 7..30, got ${pendingDays}`,
      );
    }
    try {
      await this.client.send(
        new ScheduleKeyDeletionCommand({ KeyId: kekKeyId, PendingWindowInDays: pendingDays }),
      );
    } catch (err) {
      throw wrap(err, `KMS ScheduleKeyDeletion failed for kekKeyId=${kekKeyId}`);
    }
  }

  async disableKey(kekKeyId: string): Promise<void> {
    try {
      await this.client.send(new DisableKeyCommand({ KeyId: kekKeyId }));
    } catch (err) {
      throw wrap(err, `KMS DisableKey failed for kekKeyId=${kekKeyId}`);
    }
  }
}

function wrap(cause: unknown, message: string): Error {
  const err = new Error(message);
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
}
