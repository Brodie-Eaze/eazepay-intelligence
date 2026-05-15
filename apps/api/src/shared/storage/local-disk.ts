/**
 * LocalDiskStorage — `EXPORT_STORAGE_DIR` filesystem implementation.
 *
 * Used in dev + tests. In production, only meaningful if the host has a
 * persistent volume (NOT Railway's default container FS, which is wiped
 * on every redeploy). For Railway prod, use S3Storage.
 *
 * Locator format: absolute filesystem path. Read returns a Node stream;
 * the download route pipes it to the response.
 */
import { createReadStream, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExportStorage, ReadResult, StoredFile } from './storage.interface.js';

export class LocalDiskStorage implements ExportStorage {
  constructor(private readonly root: string) {}

  async write(args: {
    exportId: string;
    extension: 'csv' | 'json';
    body: string | Buffer;
    contentType: string;
  }): Promise<StoredFile> {
    const filePath = join(this.root, `${args.exportId}.${args.extension}`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, args.body, typeof args.body === 'string' ? 'utf8' : null);
    const size =
      typeof args.body === 'string' ? Buffer.byteLength(args.body, 'utf8') : args.body.length;
    return { locator: filePath, size };
  }

  async read(locator: string): Promise<ReadResult> {
    // Defensive: reject locators that escape the storage root. The route
    // never builds locators itself, but stale rows in the DB or a future
    // bug shouldn't let one tenant's locator point into another's path.
    if (!locator.startsWith(this.root)) {
      throw new Error('local-disk: locator escapes storage root');
    }
    const stat = statSync(locator);
    return { stream: createReadStream(locator), size: stat.size };
  }
}
