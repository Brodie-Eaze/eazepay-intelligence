import { describe, expect, it } from 'vitest';
import { buildCursor, paginate, parseCursor } from '../../src/shared/utils/pagination.js';

describe('pagination', () => {
  it('round-trips a cursor', () => {
    const row = { id: 'abc', createdAt: new Date('2026-05-01T00:00:00Z') };
    const c = buildCursor(row);
    const back = parseCursor(c);
    expect(back?.id).toBe(row.id);
    expect(back?.createdAt.toISOString()).toBe(row.createdAt.toISOString());
  });

  it('paginate trims to limit and emits nextCursor', () => {
    const rows = Array.from({ length: 11 }).map((_, i) => ({
      id: `r${i}`,
      createdAt: new Date(2026, 0, i + 1),
    }));
    const page = paginate(rows, 10);
    expect(page.data.length).toBe(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it('paginate returns null cursor when no more pages', () => {
    const rows = [{ id: 'a', createdAt: new Date() }];
    const page = paginate(rows, 10);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
