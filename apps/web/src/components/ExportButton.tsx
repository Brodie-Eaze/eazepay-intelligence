'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

/**
 * Drop-in export button — opens a small popover with CSV / JSON
 * options + optional toggles (e.g. include protected-class on
 * HighSale). Hits the export endpoint with credentials, triggers a
 * browser download via Blob, fires `onComplete` so callers can refresh
 * a row counter or toast.
 *
 * Endpoints are expected to return text/csv or application/json with
 * `Content-Disposition: attachment` set — we still drive the download
 * manually so we can surface errors inline rather than letting the
 * browser swallow them.
 */

interface Toggle {
  id: string;
  label: string;
  /** Only render this toggle to users with this role (or higher). */
  requireRole?: 'ADMIN' | 'OPERATOR';
  /** Param name sent as `?<param>=true` when checked. */
  param: string;
  /** Surface a warning ribbon when the toggle is on (e.g. protected-class). */
  warningWhenOn?: string;
}

interface Props {
  /** Absolute API path (no `/api/v1` prefix — `api()` adds it). */
  endpoint: string;
  /** Pre-built URLSearchParams reflecting the current page's filters. */
  filters?: URLSearchParams;
  /** Filename hint for the download (used if the server doesn't supply
   *  Content-Disposition, which it always does in this codebase). */
  filenameHint?: string;
  /** Optional toggles rendered above the format choice. */
  toggles?: Toggle[];
  /** Current user role for toggle gating. */
  userRole?: 'ADMIN' | 'OPERATOR' | 'VIEWER' | 'INVESTOR';
}

function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3010';
}

export function ExportButton({
  endpoint,
  filters,
  filenameHint = 'export',
  toggles = [],
  userRole,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggleState, setToggleState] = useState<Record<string, boolean>>({});
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const visibleToggles = toggles.filter((t) => {
    if (!t.requireRole) return true;
    if (t.requireRole === 'ADMIN') return userRole === 'ADMIN';
    if (t.requireRole === 'OPERATOR') return userRole === 'ADMIN' || userRole === 'OPERATOR';
    return true;
  });

  const download = async (format: 'csv' | 'json'): Promise<void> => {
    setBusy(format);
    setError(null);
    try {
      const params = new URLSearchParams(filters?.toString() ?? '');
      params.set('format', format);
      for (const t of visibleToggles) {
        if (toggleState[t.id]) params.set(t.param, 'true');
      }
      const url = `${apiBase()}/api/v1${endpoint}?${params.toString()}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? ' · ' + body.slice(0, 200) : ''}`);
      }
      const blob = await res.blob();

      // Prefer the server's filename; fall back to filenameHint.
      const cd = res.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(cd);
      const filename = match?.[1] ?? `${filenameHint}.${format}`;

      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  };

  const activeWarning = visibleToggles.find((t) => t.warningWhenOn && toggleState[t.id]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-line2 text-ink2 hover:bg-paper hover:border-accent transition"
      >
        <Download size={13} />
        Export
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-[280px] rounded-lg border border-line2 bg-surface shadow-lg z-30 overflow-hidden">
          <div className="px-4 py-3 border-b border-line2">
            <div className="text-[12px] font-semibold text-ink tracking-tight">Export data</div>
            <div className="text-[11px] text-muted mt-0.5">
              Respects the current filters. Every export is audited.
            </div>
          </div>

          {visibleToggles.length > 0 && (
            <div className="px-4 py-2.5 border-b border-line2 space-y-2">
              {visibleToggles.map((t) => (
                <label key={t.id} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!toggleState[t.id]}
                    onChange={(e) => setToggleState((s) => ({ ...s, [t.id]: e.target.checked }))}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="text-[12px] text-ink2">{t.label}</span>
                </label>
              ))}
            </div>
          )}

          {activeWarning?.warningWhenOn && (
            <div className="px-4 py-2 bg-rose-500/5 border-b border-rose-500/20 text-[11px] text-rose-700 leading-snug">
              <strong>Restricted.</strong> {activeWarning.warningWhenOn}
            </div>
          )}

          <div className="p-2">
            <FormatButton
              format="csv"
              busy={busy === 'csv'}
              disabled={busy !== null}
              onClick={() => void download('csv')}
              hint=".csv · Excel-ready (UTF-8 BOM)"
            />
            <FormatButton
              format="json"
              busy={busy === 'json'}
              disabled={busy !== null}
              onClick={() => void download('json')}
              hint=".json · one record per row"
            />
          </div>

          {error && (
            <div className="px-4 py-2 border-t border-line2 bg-rose-500/5 text-[11px] text-rose-700">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FormatButton({
  format,
  busy,
  disabled,
  onClick,
  hint,
}: {
  format: 'csv' | 'json';
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  hint: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-paper transition text-left disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {busy ? (
        <Loader2 size={14} className="text-accent animate-spin" />
      ) : (
        <Download size={13} className="text-ink2" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-ink tracking-tight uppercase">{format}</div>
        <div className="text-[10px] text-muted">{hint}</div>
      </div>
    </button>
  );
}
