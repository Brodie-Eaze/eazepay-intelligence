/**
 * S3Storage — AWS S3 implementation of ExportStorage (GAP-109).
 *
 * Activated by `EXPORT_STORAGE_DRIVER=s3` at boot. Required for Railway-
 * hosted production: Railway's filesystem is ephemeral, so any local
 * disk write loses on the next deploy. S3 gives us durable export storage
 * + short-lived presigned URLs for the download route (15-minute TTL
 * default — long enough for a user to click the link, short enough to
 * cap the blast radius of a logged URL).
 *
 * Required env:
 *   - AWS_REGION              (e.g. `ap-southeast-2` for Sydney)
 *   - EXPORT_S3_BUCKET        the bucket to write into
 *   - EXPORT_S3_PREFIX        optional key prefix (e.g. `exports/`)
 *   - EXPORT_PRESIGN_TTL_SEC  default 900 (15min)
 *
 * The IAM role on the Railway service needs:
 *   - s3:PutObject on arn:aws:s3:::<bucket>/<prefix>*
 *   - s3:GetObject on the same (for presigned URL signing)
 *
 * NOTE: this module imports @aws-sdk/client-s3 + s3-request-presigner
 * LAZILY so dev builds without AWS deps don't break. If you switch
 * the driver to s3, those packages must be installed:
 *   pnpm --filter api add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 *
 * Locator format: `s3://<bucket>/<key>`. read() returns a presigned URL;
 * the download route returns a 302 redirect to it instead of streaming.
 */
import type { ExportStorage, ReadResult, StoredFile } from './storage.interface.js';

interface S3StorageConfig {
  region: string;
  bucket: string;
  prefix: string;
  presignTtlSeconds: number;
}

// Dynamic-typed handle — module shape varies across AWS SDK minor versions.
type S3Client = { send: (cmd: unknown) => Promise<unknown> };

interface AwsModules {
  client: S3Client;
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  getSignedUrl: (
    client: S3Client,
    command: unknown,
    opts: { expiresIn: number },
  ) => Promise<string>;
}

export class S3Storage implements ExportStorage {
  private modules: AwsModules | undefined;

  constructor(private readonly cfg: S3StorageConfig) {}

  /** Visible to the builder so it can warm modules at boot (fail-closed). */
  async ensureModules(): Promise<AwsModules> {
    if (this.modules) return this.modules;
    // Lazy-load so dev builds without aws-sdk installed don't crash at
    // module-load time. The error message is intentionally direct so the
    // operator sees the required `pnpm add` command.
    try {
      const s3Mod = (await import('@aws-sdk/client-s3' as unknown as string)) as {
        S3Client: new (cfg: { region: string }) => S3Client;
        PutObjectCommand: new (input: Record<string, unknown>) => unknown;
        GetObjectCommand: new (input: Record<string, unknown>) => unknown;
      };
      const presignMod = (await import('@aws-sdk/s3-request-presigner' as unknown as string)) as {
        getSignedUrl: (
          client: S3Client,
          command: unknown,
          opts: { expiresIn: number },
        ) => Promise<string>;
      };
      const client = new s3Mod.S3Client({ region: this.cfg.region });
      this.modules = {
        client,
        PutObjectCommand: s3Mod.PutObjectCommand,
        GetObjectCommand: s3Mod.GetObjectCommand,
        getSignedUrl: presignMod.getSignedUrl,
      };
      return this.modules;
    } catch (err) {
      throw new Error(
        's3-storage: failed to load aws-sdk modules. Run ' +
          '`pnpm --filter api add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` ' +
          'and redeploy. Underlying: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  async write(args: {
    exportId: string;
    extension: 'csv' | 'json';
    body: string | Buffer;
    contentType: string;
  }): Promise<StoredFile> {
    const mods = await this.ensureModules();
    const key = `${this.cfg.prefix}${args.exportId}.${args.extension}`;
    const buf = typeof args.body === 'string' ? Buffer.from(args.body, 'utf8') : args.body;
    await mods.client.send(
      new mods.PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: buf,
        ContentType: args.contentType,
        // Server-side encryption at rest (defence-in-depth on top of
        // bucket-default SSE). The IAM policy should also require it.
        ServerSideEncryption: 'AES256',
      }),
    );
    return { locator: `s3://${this.cfg.bucket}/${key}`, size: buf.length };
  }

  async read(locator: string): Promise<ReadResult> {
    if (!locator.startsWith(`s3://${this.cfg.bucket}/`)) {
      throw new Error('s3-storage: locator does not match configured bucket');
    }
    const key = locator.slice(`s3://${this.cfg.bucket}/`.length);
    const mods = await this.ensureModules();
    const presignedUrl = await mods.getSignedUrl(
      mods.client,
      new mods.GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn: this.cfg.presignTtlSeconds },
    );
    return { kind: 'redirect', presignedUrl };
  }
}

/**
 * Build an S3Storage from process.env. Throws at boot if any required
 * variable is missing OR if the AWS SDK isn't installed — fail-closed
 * so a misconfigured prod startup is visible immediately rather than
 * at first export attempt (ARCH critic blocker #4: the comment in
 * storage.interface.ts promised boot-time fail-closed; the previous
 * lazy-import broke that promise).
 */
export async function buildS3StorageFromEnv(): Promise<S3Storage> {
  const region = process.env.AWS_REGION;
  const bucket = process.env.EXPORT_S3_BUCKET;
  const prefix = process.env.EXPORT_S3_PREFIX ?? 'exports/';
  const ttl = Number(process.env.EXPORT_PRESIGN_TTL_SEC ?? 900);
  if (!region) throw new Error('s3-storage: AWS_REGION is required');
  if (!bucket) throw new Error('s3-storage: EXPORT_S3_BUCKET is required');
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 3600) {
    throw new Error('s3-storage: EXPORT_PRESIGN_TTL_SEC must be 60..3600');
  }
  const storage = new S3Storage({ region, bucket, prefix, presignTtlSeconds: ttl });
  // Eager-load the aws-sdk modules at boot. The first write/read no
  // longer pays a dynamic-import cost AND a missing dep crashes the
  // API at startup, not on the first export job mid-flight.
  await storage.ensureModules();
  return storage;
}
