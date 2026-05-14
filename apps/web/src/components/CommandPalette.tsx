'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ArrowRight, Hash } from 'lucide-react';

/**
 * Command palette — ⌘K / Ctrl-K to open from anywhere.
 *
 * Two surfaces in one:
 *   1. Route jump — fuzzy-search the full route catalogue (every page
 *      in the sidebar + parametric route slugs).
 *   2. Customer lookup — if the query looks like an email, normalise +
 *      hash + deep-link to /customers/<hash>. If it looks like a
 *      partner external id (PRT-XXXX), jump to that partner.
 *
 * The signature enterprise move. Stripe / Linear / Vercel all ship
 * this. Once a team learns it they never use the sidebar again.
 */

interface Command {
  label: string;
  hint?: string;
  href: string;
  keywords?: string[];
}

const COMMANDS: Command[] = [
  // Overview + portfolio
  { label: 'Overview', href: '/overview', keywords: ['home', 'holdco', 'dashboard'] },
  { label: 'Live activity', href: '/live', keywords: ['ticker', 'realtime', 'events'] },
  { label: 'Holdco rollup', href: '/portfolio', keywords: ['portfolio', 'group', 'businesses'] },

  // Customers + applications
  { label: 'Customer book', href: '/customers', keywords: ['customers', 'applicants', 'people'] },
  { label: 'All applications', href: '/applications', keywords: ['apps', 'submitted'] },
  { label: 'Applications by status', href: '/applications/by-status', keywords: ['pipeline'] },
  { label: 'Funnel', href: '/funnel', keywords: ['conversion', 'submitted approved funded'] },
  { label: 'Risk profiles', href: '/risk', keywords: ['credit', 'tier', 'band'] },
  { label: 'Income & affordability', href: '/income', keywords: ['income', 'affordability'] },
  { label: 'Propensity calibration', href: '/propensity', keywords: ['propensity', 'calibration'] },

  // Revenue
  { label: 'Revenue overview', href: '/revenue', keywords: ['revenue', 'rev'] },
  {
    label: 'Revenue by stream',
    href: '/revenue/streams',
    keywords: ['stream', 'highsale lender micamp'],
  },
  { label: 'Append-only ledger', href: '/revenue/ledger', keywords: ['ledger'] },
  { label: 'Reconciliation', href: '/revenue/reconciliation', keywords: ['recon'] },

  // Data sources
  { label: 'Data sources', href: '/data-sources', keywords: ['sources', 'feeds', 'ingestion'] },
  {
    label: 'HighSale (EZ Check)',
    href: '/highsale',
    keywords: ['credit', 'enrichment', 'ezcheck'],
  },
  { label: 'Pixie', href: '/pixie', keywords: ['pixie', 'pulls'] },
  { label: 'Pixie pricing', href: '/pixie/pricing', keywords: ['breakpoint', 'margin'] },
  { label: 'MiCamp', href: '/micamp', keywords: ['micamp', 'processing'] },
  { label: 'Lenders', href: '/lenders', keywords: ['lender', 'book'] },
  { label: 'Partners', href: '/partners', keywords: ['partner', 'merchant'] },
  { label: 'Webhook events log', href: '/ops/webhooks', keywords: ['webhook', 'inbound'] },

  // Operations
  { label: 'Alerts', href: '/alerts', keywords: ['alert', 'incident'] },
  { label: 'Global search', href: '/search', keywords: ['search'] },
  { label: 'System health', href: '/ops/health', keywords: ['health', 'status'] },
  { label: 'Job queues', href: '/ops/queues', keywords: ['queue', 'bullmq'] },
  { label: 'Sessions', href: '/ops/sessions', keywords: ['session', 'login'] },
  { label: 'Tags', href: '/tags', keywords: ['tag'] },

  // Governance
  { label: 'Audit log', href: '/audit', keywords: ['audit', 'trail'] },
  { label: 'PII access log', href: '/audit/pii', keywords: ['pii', 'access'] },
  { label: 'Login log', href: '/audit/logins', keywords: ['login', 'sign in'] },

  // Admin
  { label: 'Users & roles', href: '/admin', keywords: ['user', 'role', 'admin'] },
  { label: 'Pricing config', href: '/admin/pricing', keywords: ['pricing', 'rev share'] },
  { label: 'Secrets inventory', href: '/admin/secrets', keywords: ['secret', 'env', 'hmac'] },
  { label: 'API tokens', href: '/tokens', keywords: ['token', 'pat', 'api'] },
  { label: 'Data exports', href: '/exports', keywords: ['export', 'csv'] },
  { label: 'Scheduled reports', href: '/reports', keywords: ['report', 'schedule'] },
  { label: 'Outbound webhooks', href: '/subscriptions', keywords: ['outbound', 'subscription'] },
];

function score(cmd: Command, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const label = cmd.label.toLowerCase();
  const href = cmd.href.toLowerCase();
  const kw = (cmd.keywords ?? []).join(' ').toLowerCase();

  // Exact label match: top
  if (label === q) return 1000;
  // Starts with query in label: very high
  if (label.startsWith(q)) return 900 - (label.length - q.length);
  // Word boundary match in label: high
  const labelWords = label.split(/\s+/);
  if (labelWords.some((w) => w.startsWith(q))) return 800;
  // href match
  if (href.includes(q)) return 600;
  // Keyword match
  if (kw.includes(q)) return 500;
  // Substring match in label
  if (label.includes(q)) return 400;
  return 0;
}

async function sha256Hex(input: string): Promise<string> {
  // Browser SubtleCrypto SHA-256 — same digest the server uses.
  // (Not a Buffer/HMAC, plain SHA-256 hex of normalised lowercased email.)
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input.trim().toLowerCase()));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      // focus next tick — Safari needs the modal to be in the DOM
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const isEmail = useMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim()), [query]);
  const looksLikeHash = /^[a-f0-9]{64}$/i.test(query.trim());
  const partnerExternal = /^PRT-\d+$/i.test(query.trim());

  const routeMatches = useMemo(() => {
    if (!query) return COMMANDS.slice(0, 8); // default: top-of-mind
    const scored = COMMANDS.map((c) => ({ cmd: c, s: score(c, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 10);
    return scored.map((x) => x.cmd);
  }, [query]);

  // Special actions when query is an email / hash / partner ID
  type Action = { label: string; hint: string; run: () => Promise<void> | void };
  const specialActions: Action[] = useMemo(() => {
    const list: Action[] = [];
    if (isEmail) {
      list.push({
        label: `Customer · ${query}`,
        hint: 'sha256(email) → /customers/<hash>',
        run: async () => {
          const hash = await sha256Hex(query);
          router.push(`/customers/${hash}`);
          onClose();
        },
      });
    }
    if (looksLikeHash) {
      list.push({
        label: `Open customer ${query.slice(0, 12)}…`,
        hint: 'jump to customer detail',
        run: () => {
          router.push(`/customers/${query.trim()}`);
          onClose();
        },
      });
    }
    if (partnerExternal) {
      list.push({
        label: `Partner ${query.toUpperCase()}`,
        hint: 'jump to partner directory',
        run: () => {
          router.push(`/partners?q=${encodeURIComponent(query.trim())}`);
          onClose();
        },
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isEmail, looksLikeHash, partnerExternal]);

  // Combined entries for keyboard cursor
  const entries: Array<{ kind: 'action'; action: Action } | { kind: 'route'; cmd: Command }> =
    useMemo(() => {
      const a = specialActions.map((x) => ({ kind: 'action' as const, action: x }));
      const r = routeMatches.map((x) => ({ kind: 'route' as const, cmd: x }));
      return [...a, ...r];
    }, [specialActions, routeMatches]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(entries.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = entries[cursor];
      if (!target) return;
      if (target.kind === 'action') {
        void target.action.run();
      } else {
        router.push(target.cmd.href);
        onClose();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-[#0B1220]/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-2xl rounded-xl border border-line2 bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-line2">
          <Search size={18} className="text-soft" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to · search customer by email · partner id (PRT-…)"
            className="flex-1 bg-transparent outline-none text-[14px] text-ink placeholder:text-soft"
          />
          <kbd className="text-[10px] text-soft border border-line2 rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {entries.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted">
              No matches. Try typing a route name, an email, or a partner id.
            </div>
          ) : (
            <div className="py-1">
              {specialActions.length > 0 && (
                <div className="px-5 py-1.5 text-[10px] uppercase tracking-[0.18em] text-muted">
                  Actions
                </div>
              )}
              {entries.map((e, i) => {
                const active = i === cursor;
                if (e.kind === 'action') {
                  return (
                    <button
                      key={`a-${i}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => void e.action.run()}
                      className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition ${
                        active ? 'bg-accentSoft text-ink' : 'text-ink2 hover:bg-paper'
                      }`}
                    >
                      <Hash size={14} className={active ? 'text-accent' : 'text-soft'} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium tracking-tight truncate">
                          {e.action.label}
                        </div>
                        <div className="text-[10px] text-muted">{e.action.hint}</div>
                      </div>
                      {active && <ArrowRight size={14} className="text-accent" />}
                    </button>
                  );
                }
                if (i === specialActions.length && specialActions.length > 0) {
                  return (
                    <div key="sep">
                      <div className="px-5 py-1.5 mt-1 text-[10px] uppercase tracking-[0.18em] text-muted">
                        Jump to
                      </div>
                      <RouteRow
                        cmd={e.cmd}
                        active={active}
                        onHover={() => setCursor(i)}
                        onClick={() => {
                          router.push(e.cmd.href);
                          onClose();
                        }}
                      />
                    </div>
                  );
                }
                return (
                  <RouteRow
                    key={e.cmd.href}
                    cmd={e.cmd}
                    active={active}
                    onHover={() => setCursor(i)}
                    onClick={() => {
                      router.push(e.cmd.href);
                      onClose();
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-line2 flex items-center justify-between text-[10px] text-muted">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="border border-line2 rounded px-1">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="border border-line2 rounded px-1">↵</kbd> open
            </span>
            <span>
              <kbd className="border border-line2 rounded px-1">esc</kbd> close
            </span>
          </div>
          <span className="text-soft">
            {entries.length} result{entries.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>
  );
}

function RouteRow({
  cmd,
  active,
  onClick,
  onHover,
}: {
  cmd: Command;
  active: boolean;
  onClick: () => void;
  onHover: () => void;
}): JSX.Element {
  return (
    <button
      onMouseEnter={onHover}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition ${
        active ? 'bg-accentSoft text-ink' : 'text-ink2 hover:bg-paper'
      }`}
    >
      <ArrowRight size={14} className={active ? 'text-accent' : 'text-soft'} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium tracking-tight truncate">{cmd.label}</div>
        <code className="text-[10px] text-muted">{cmd.href}</code>
      </div>
    </button>
  );
}

/**
 * Hook to wire the ⌘K / Ctrl-K listener on the app shell.
 */
export function useCommandPalette(): { open: boolean; setOpen: (v: boolean) => void } {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { open, setOpen };
}
