/**
 * CSV writer — RFC-4180 compliant, streaming-safe.
 *
 * Use over `JSON.stringify(rows).replace(...)` ad-hoc hacks because:
 *   - Excel quoting rules are unforgiving (a stray comma in a string
 *     silently breaks the row alignment downstream)
 *   - Embedded newlines, quotes, and CR characters need escaping
 *   - BOM helps Excel-on-Windows display UTF-8 correctly without
 *     prompting for an encoding
 *
 * Not a streaming API yet — callers receive a string. The export
 * endpoints in this codebase return ≤ 50,000 rows; if we cross that
 * threshold, swap to a Node Readable that yields one row at a time.
 */

/**
 * Escape a single CSV cell. Wrap in quotes when the value contains
 * `,`, `"`, CR, or LF. Doubled quotes inside a quoted value.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  // Buffer / bytea → hex (analytical hashes are bytea in Postgres)
  if (Buffer.isBuffer(value)) return value.toString('hex');
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Render `rows` as CSV. The first element of `columns` is the header
 * row; field values are pulled with `pick(row, columnName)` so each
 * column can map a key path like `data.score`.
 *
 * Always emits CRLF (RFC-4180) + a UTF-8 BOM so Excel-on-Windows
 * doesn't mangle special characters.
 */
export function rowsToCsv<T>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<{ key: string; label?: string; pick?: (row: T) => unknown }>,
): string {
  const header = columns.map((c) => csvEscape(c.label ?? c.key)).join(',');
  const body = rows
    .map((row) =>
      columns
        .map((c) => {
          if (c.pick) return csvEscape(c.pick(row));
          // Fallback: index-by-key when no pick is supplied.
          const v = (row as Record<string, unknown>)[c.key];
          return csvEscape(v);
        })
        .join(','),
    )
    .join('\r\n');
  // BOM (﻿) so Excel-on-Windows opens UTF-8 cleanly.
  return `﻿${header}\r\n${body}\r\n`;
}

/**
 * Build a Content-Disposition value for an attachment download.
 * Uses RFC-5987 `filename*=UTF-8''` form so unicode filenames survive.
 */
export function attachmentHeader(filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
