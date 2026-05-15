import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { LocalDiskStorage } from '../../src/shared/storage/local-disk.js';

describe('LocalDiskStorage', () => {
  let root: string;
  let storage: LocalDiskStorage;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'eazepay-storage-test-'));
    storage = new LocalDiskStorage(root);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a string body and reports the locator + size', async () => {
    const r = await storage.write({
      exportId: 'test-1',
      extension: 'csv',
      body: 'a,b,c\n1,2,3\n',
      contentType: 'text/csv',
    });
    expect(r.locator).toBe(join(root, 'test-1.csv'));
    expect(r.size).toBe(12);
    expect(readFileSync(r.locator, 'utf8')).toBe('a,b,c\n1,2,3\n');
  });

  it('read() returns a stream + size on the kind=stream branch', async () => {
    const r = await storage.write({
      exportId: 'test-2',
      extension: 'json',
      body: '{}',
      contentType: 'application/json',
    });
    const read = await storage.read(r.locator);
    expect(read.kind).toBe('stream');
    if (read.kind !== 'stream') throw new Error('expected stream');
    expect(read.size).toBe(2);
    expect(read.stream).toBeDefined();
    // Consume + close the stream so the afterAll cleanup doesn't race
    // a held file handle.
    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      read.stream.on('data', (c: Buffer) => chunks.push(c));
      read.stream.on('end', resolve);
      read.stream.on('error', reject);
    });
  });

  it('SEC-201: rejects a sibling-path locator escape', async () => {
    // `${root}-evil` would pass a naive `startsWith(root)` check.
    const evilLocator = `${root}-evil${sep}foo.csv`;
    await expect(storage.read(evilLocator)).rejects.toThrow(/escapes storage root/);
  });

  it('SEC-201: rejects a parent-traversal locator', async () => {
    const traversal = join(root, '..', 'evil.csv');
    await expect(storage.read(traversal)).rejects.toThrow(/escapes storage root/);
  });
});
