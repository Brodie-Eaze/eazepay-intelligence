/**
 * Storage boot wiring.
 *
 * Called once at process startup (from config/storage.ts boot hook) to
 * register the right ExportStorage based on EXPORT_STORAGE_DRIVER:
 *
 *   - `local` (default) — LocalDiskStorage(EXPORT_STORAGE_DIR)
 *   - `s3`              — S3Storage(<env-driven config>)
 *
 * Unknown driver → fail-closed throw at boot, not at first export.
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

export function registerExportStorageFromEnv(): void {
  const driver = (process.env.EXPORT_STORAGE_DRIVER ?? 'local').toLowerCase();
  switch (driver) {
    case 'local': {
      const root = process.env.EXPORT_STORAGE_DIR ?? join(process.cwd(), 'tmp', 'exports');
      setExportStorage(new LocalDiskStorage(root));
      return;
    }
    case 's3': {
      setExportStorage(buildS3StorageFromEnv());
      return;
    }
    default:
      throw new Error(
        `export-storage: unknown EXPORT_STORAGE_DRIVER=${driver}. Expected "local" or "s3".`,
      );
  }
}
