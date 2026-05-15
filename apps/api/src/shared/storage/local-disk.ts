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
import { dirname, join, resolve, sep } from 'node:path';
import type { ExportStorage, ReadResult, StoredFile } from './storage.interface.js';

export class LocalDiskStorage implements ExportStorage {
  // Resolved + separator-terminated so a sibling like `/tmp/exports-evil`
  // cannot match a prefix check against `/tmp/exports` (SEC-201).
  private readonly rootResolved: string;

  constructor(private readonly root: string) {
    this.rootResolved = resolve(root) + sep;
  }

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
    // SEC-201 (CWE-22, path traversal defence): resolve the locator
    // and assert it sits strictly under the configured root. Prefix
    // check on raw strings was vulnerable to sibling paths like
    // `/tmp/exports-evil/file.csv` passing `startsWith('/tmp/exports')`.
    const resolved = resolve(locator);
    if (!resolved.startsWith(this.rootResolved)) {
      throw new Error('local-disk: locator escapes storage root');
    }
    const stat = statSync(resolved);
    return { kind: 'stream', stream: createReadStream(resolved), size: stat.size };
  }
}
