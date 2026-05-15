/**
 * Storage boot wiring.
 *
 * Called once at process startup (from src/index.ts + each worker's
 * boot hook) to register the right ExportStorage based on
 * EXPORT_STORAGE_DRIVER:
 *
 *   - `local` (default in non-prod) — LocalDiskStorage(EXPORT_STORAGE_DIR)
 *   - `s3`                          — S3Storage(<env-driven config>)
 *
 * SEC-204: in production, EXPORT_STORAGE_DRIVER must be explicitly
 * set. The default of `local` on Railway's ephemeral filesystem
 * silently loses every export across redeploys — a quiet data-loss
 * mode for a finance product. Fail-closed at boot instead.
 *
 * Unknown driver → fail-closed throw at boot, not at first export.
 *
 * ARCH-4 (S3 fail-closed): we await `buildS3StorageFromEnv()` so the
 * aws-sdk dynamic import is exercised at boot; missing dep crashes
 * startup instead of crashing mid-job.
 */
import { join } from 'node:path';
import { LocalDiskStorage } from './local-disk.js';
import { buildS3StorageFromEnv } from './s3.js';
import {
  getExportStorage,
  setExportStorage,
  __resetExportStorageForTests,
} from './storage.interface.js';

export type { ExportStorage, StoredFile, ReadResult } from './storage.interface.js';
export { getExportStorage, setExportStorage, __resetExportStorageForTests };

export async function registerExportStorageFromEnv(): Promise<void> {
  const explicit = process.env.EXPORT_STORAGE_DRIVER;
  if (process.env.NODE_ENV === 'production' && !explicit) {
    throw new Error(
      'export-storage: EXPORT_STORAGE_DRIVER must be explicitly set in production ' +
        '(local on Railway loses exports across redeploys). Set to "s3" with the ' +
        'EXPORT_S3_BUCKET / AWS_REGION / EXPORT_PRESIGN_TTL_SEC env vars.',
    );
  }
  const driver = (explicit ?? 'local').toLowerCase();
  switch (driver) {
    case 'local': {
      const root = process.env.EXPORT_STORAGE_DIR ?? join(process.cwd(), 'tmp', 'exports');
      setExportStorage(new LocalDiskStorage(root));
      return;
    }
    case 's3': {
      // Eager-load the aws-sdk modules at boot so a missing dep crashes
      // startup, not the first export. The builder calls ensureModules().
      setExportStorage(await buildS3StorageFromEnv());
      return;
    }
    default:
      throw new Error(
        `export-storage: unknown EXPORT_STORAGE_DRIVER=${driver}. Expected "local" or "s3".`,
      );
  }
}
