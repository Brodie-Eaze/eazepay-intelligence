/**
 * Export-storage interface (GAP-109).
 *
 * Two implementations live side-by-side:
 *
 *   - `LocalDiskStorage` (storage/local-disk.ts) — writes to
 *     `EXPORT_STORAGE_DIR` (defaults to `./tmp/exports`). The default in
 *     dev + tests, and the historical production behaviour on Railway.
 *
 *   - `S3Storage` (storage/s3.ts) — writes to S3, returns presigned URLs
 *     for downloads. Production when `EXPORT_STORAGE_DRIVER=s3`. Required
 *     for Railway-hosted production because Railway's filesystem is
 *     ephemeral — local disk loses every export across redeploys.
 *
 * The driver is selected at boot via `EXPORT_STORAGE_DRIVER` env. Either
 * implementation is used identically by export.service.ts; the route's
 * /exports/:id/download branches on the storage backend's reported
 * locator type — `disk:<path>` (stream-from-disk) or `s3:<key>` (redirect
 * to presigned URL).
 *
 * Design constraints:
 *   - Driver code MUST NOT throw on missing env at module load — we
 *     register the storage client at boot, like KmsClient. A failed
 *     registration fails closed (every export errors with a clean
 *     "storage backend not configured" message rather than a stack
 *     trace).
 *   - Locator strings are opaque to callers; only the storage backend
 *     parses them. This keeps the schema column (Export.file_path)
 *     identically-typed across backends.
 *   - Reads return a Node `Readable` stream — backed by `fs.createReadStream`
 *     on disk or a presigned-URL redirect (304 to client) on S3. The
 *     download route handles both.
 */
import type { Readable } from 'node:stream';

export interface StoredFile {
  /**
   * Opaque locator stored in `Export.file_path`. Implementation-defined:
   *   - LocalDiskStorage emits the absolute fs path.
   *   - S3Storage emits `s3://<bucket>/<key>`.
   * Callers MUST pass this back unchanged to `read()` or `presignedUrl()`.
   */
  locator: string;
  /** Bytes written. */
  size: number;
}

/**
 * Discriminated union: callers must check `kind` and TypeScript will
 * narrow to the right shape. The previous "two optional fields" version
 * relied on runtime presence checks and let a future S3-can-also-stream
 * change silently break the route.
 */
export type ReadResult =
  | { kind: 'stream'; stream: Readable; size: number }
  | { kind: 'redirect'; presignedUrl: string };

export interface ExportStorage {
  /**
   * Persist `body` under `exportId`. Returns the locator + size. Idempotent
   * by exportId — re-running overwrites the prior bytes.
   */
  write(args: {
    exportId: string;
    extension: 'csv' | 'json';
    body: string | Buffer;
    contentType: string;
  }): Promise<StoredFile>;

  /**
   * Read by locator. Returns either a stream (local) or a presigned URL
   * (s3). Caller branches on which is set. Throws if the backend can't
   * resolve the locator.
   */
  read(locator: string): Promise<ReadResult>;
}

let registered: ExportStorage | undefined;

export function setExportStorage(s: ExportStorage): void {
  registered = s;
}

export function getExportStorage(): ExportStorage {
  if (!registered) {
    throw new Error(
      'export-storage: no driver registered. Call setExportStorage() at boot ' +
        '(LocalDiskStorage for dev, S3Storage for prod).',
    );
  }
  return registered;
}

export function __resetExportStorageForTests(): void {
  registered = undefined;
}
