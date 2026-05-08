/**
 * In-process LRU cache for unwrapped Data Encryption Keys.
 *
 * Per ADR-002 §5: each `TenantEncryptionKey.id` maps to a 32-byte plaintext
 * DEK. The KMS unwrap call is expensive (network round-trip + IAM check) so
 * we cache the plaintext for the process lifetime, bounded by an LRU + TTL.
 *
 * Eviction policy:
 *   - LRU: drop oldest-accessed when size exceeds `maxEntries`.
 *   - TTL: drop entry on read if age > `ttlMs`.
 *
 * Memory:
 *   - 32 bytes per DEK + Map overhead. 1 000 entries ≈ 50 KB. Negligible.
 *   - DEKs are held as Buffers; Node GC collects on eviction. Workers that
 *     hold references explicitly (the re-encryption worker) call `clear()`
 *     on shutdown.
 *
 * Cache invalidation on rotation:
 *   - `evict(keyId)` — used by the rotation runbook + Redis pub/sub
 *     `key:retired:<keyId>` listener (Phase 1.5 expansion).
 */

interface CacheEntry {
  readonly dek: Buffer;
  readonly insertedAt: number;
  // mutable for LRU bookkeeping — the value here is rewritten on every read.
  lastAccessed: number;
}

export class DekCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(opts: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 1_000;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1_000; // 1 hour
  }

  get(keyId: string): Buffer | undefined {
    const e = this.entries.get(keyId);
    if (!e) return undefined;
    const now = Date.now();
    if (now - e.insertedAt > this.ttlMs) {
      this.entries.delete(keyId);
      return undefined;
    }
    e.lastAccessed = now;
    return e.dek;
  }

  set(keyId: string, dek: Buffer): void {
    if (dek.length !== 32) {
      throw new Error(`DekCache: DEK must be 32 bytes, got ${dek.length}`);
    }
    if (this.entries.size >= this.maxEntries && !this.entries.has(keyId)) {
      this.evictOldest();
    }
    const now = Date.now();
    this.entries.set(keyId, { dek, insertedAt: now, lastAccessed: now });
  }

  evict(keyId: string): boolean {
    return this.entries.delete(keyId);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [k, v] of this.entries) {
      if (v.lastAccessed < oldestTime) {
        oldestTime = v.lastAccessed;
        oldestKey = k;
      }
    }
    if (oldestKey) this.entries.delete(oldestKey);
  }
}

/** Process-wide singleton instance. */
let singleton: DekCache | undefined;

export function getDekCache(): DekCache {
  if (!singleton) singleton = new DekCache();
  return singleton;
}

export function __resetDekCacheForTests(): void {
  singleton = undefined;
}
