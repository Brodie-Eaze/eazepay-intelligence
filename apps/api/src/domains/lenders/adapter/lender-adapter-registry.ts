/**
 * Lender adapter registry (GAP-101).
 *
 * Adapters register themselves at process bootstrap. Routes + workers
 * resolve by slug. The registry is intentionally a tiny in-memory map —
 * the set of lenders is small (single digits today) and slow-changing.
 *
 * When a real lender adapter ships, its module calls
 * `registerLenderAdapter(new XYZLenderAdapter())` from a boot hook.
 */
import type { LenderAdapter } from './lender-adapter.interface.js';

const adapters = new Map<string, LenderAdapter>();

export function registerLenderAdapter(adapter: LenderAdapter): void {
  if (adapters.has(adapter.slug)) {
    throw new Error(`lender-adapter: ${adapter.slug} already registered`);
  }
  adapters.set(adapter.slug, adapter);
}

export function getLenderAdapter(slug: string): LenderAdapter | undefined {
  return adapters.get(slug);
}

export function listLenderAdapters(): LenderAdapter[] {
  return [...adapters.values()];
}

export function __resetLenderRegistryForTests(): void {
  adapters.clear();
}
