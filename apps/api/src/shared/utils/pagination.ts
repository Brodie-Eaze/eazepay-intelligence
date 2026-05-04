import { z } from 'zod';
import { errors } from '../errors/app-error.js';

/**
 * Cursor-based pagination. Cursor is opaque base64url("<isoTimestamp>|<id>").
 * Stable under concurrent inserts because both fields are immutable per row.
 */

export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface DecodedCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function buildCursor(row: { createdAt: Date; id: string }): string {
  const raw = `${row.createdAt.toISOString()}|${row.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function parseCursor(cursor: string | undefined): DecodedCursor | undefined {
  if (!cursor) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw errors.badRequest('Invalid cursor encoding');
  }
  const sep = decoded.indexOf('|');
  if (sep < 0) throw errors.badRequest('Invalid cursor format');
  const ts = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  const createdAt = new Date(ts);
  if (Number.isNaN(createdAt.getTime()) || !id) {
    throw errors.badRequest('Invalid cursor payload');
  }
  return { createdAt, id };
}

export interface Paginated<T> {
  data: readonly T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Page a list result. Caller fetches `limit + 1` rows; we trim and emit the cursor.
 */
export function paginate<T extends { createdAt: Date; id: string }>(
  rows: readonly T[],
  limit: number,
): Paginated<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const tail = data[data.length - 1];
  const nextCursor = hasMore && tail ? buildCursor(tail) : null;
  return { data, nextCursor, hasMore };
}
