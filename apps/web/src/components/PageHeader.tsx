'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronRight, ChevronLeft } from 'lucide-react';

/**
 * Unified page header. Sets the enterprise standard for every page.
 *
 *   ← back        Section · Sub · This page                    [action]
 *   ─────────────────────────────────────────────────────────────────
 *     TITLE                                              · live indicator
 *     subtitle
 *
 * Backward-compatible with the previous PageHeader contract — `title`,
 * `subtitle` (ReactNode), `action`, `hideBack` all still work. New
 * optional props: `crumbs`, `status`.
 *
 * Breadcrumbs auto-derive from pathname when `crumbs` is omitted.
 * Back button hidden on /overview and the root.
 */

interface Crumb {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  /** Hide the back arrow even when not on an overview/root page. */
  hideBack?: boolean;
  /** Override the auto-derived breadcrumb trail. */
  crumbs?: Crumb[];
  /** Status pill rendered next to the title. */
  status?: { label: string; tone: 'live' | 'fresh' | 'stale' | 'idle' };
}

const HUMANISE: Record<string, string> = {
  overview: 'Overview',
  portfolio: 'Holdco',
  customers: 'Customers',
  applications: 'Applications',
  'by-status': 'By status',
  funnel: 'Funnel',
  risk: 'Risk',
  income: 'Income',
  propensity: 'Propensity',
  revenue: 'Revenue',
  streams: 'Streams',
  ledger: 'Ledger',
  reconciliation: 'Reconciliation',
  'data-sources': 'Data sources',
  highsale: 'HighSale',
  pixie: 'Pixie',
  pricing: 'Pricing',
  micamp: 'MiCamp',
  lenders: 'Lenders',
  partners: 'Partners',
  ops: 'Operations',
  webhooks: 'Webhooks',
  health: 'Health',
  queues: 'Queues',
  sessions: 'Sessions',
  alerts: 'Alerts',
  search: 'Search',
  tags: 'Tags',
  audit: 'Audit',
  pii: 'PII access',
  logins: 'Logins',
  admin: 'Admin',
  secrets: 'Secrets',
  tokens: 'Tokens',
  exports: 'Exports',
  reports: 'Reports',
  subscriptions: 'Outbound webhooks',
  live: 'Live',
};

function deriveCrumbs(path: string | null): Crumb[] {
  if (!path) return [];
  const segments = path.split('/').filter(Boolean);
  return segments.map((seg, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    const isLast = i === segments.length - 1;
    const label = HUMANISE[seg] ?? seg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return isLast ? { label } : { label, href };
  });
}

const TONE_STYLE: Record<NonNullable<PageHeaderProps['status']>['tone'], string> = {
  live: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  fresh: 'bg-blue-500/10 text-blue-700 border-blue-500/30',
  stale: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  idle: 'bg-slate-500/10 text-slate-600 border-slate-500/30',
};

const TONE_PULSE: Record<NonNullable<PageHeaderProps['status']>['tone'], string> = {
  live: 'bg-emerald-500 animate-pulse',
  fresh: 'bg-blue-500',
  stale: 'bg-amber-500',
  idle: 'bg-slate-400',
};

export function PageHeader({
  title,
  subtitle,
  action,
  hideBack,
  crumbs,
  status,
}: PageHeaderProps): JSX.Element {
  const path = usePathname() ?? '';
  const router = useRouter();
  const computedCrumbs = crumbs ?? deriveCrumbs(path);
  const showBack = !hideBack && path !== '/' && path !== '/overview';

  const onBack = (): void => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    const parts = path.split('/').filter(Boolean);
    const parent = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/overview';
    router.push(parent);
  };

  return (
    <div className="mb-6">
      {/* Breadcrumbs row */}
      {computedCrumbs.length > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-muted mb-3 flex-wrap">
          {showBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 text-ink2 hover:text-ink transition mr-1"
              aria-label="Go back"
            >
              <ChevronLeft size={13} />
              <span>Back</span>
            </button>
          )}
          {computedCrumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              {c.href ? (
                <Link href={c.href} className="hover:text-ink2 transition">
                  {c.label}
                </Link>
              ) : (
                <span className="text-ink2">{c.label}</span>
              )}
              {i < computedCrumbs.length - 1 && <ChevronRight size={12} className="text-soft" />}
            </span>
          ))}
        </div>
      )}

      {/* Title row */}
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[22px] lg:text-[26px] font-semibold tracking-tight text-ink">
              {title}
            </h1>
            {status && (
              <span
                className={`inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full border ${TONE_STYLE[status.tone]}`}
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full ${TONE_PULSE[status.tone]}`}
                />
                {status.label}
              </span>
            )}
          </div>
          {subtitle && <p className="text-sm text-muted mt-1.5 max-w-3xl">{subtitle}</p>}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
    </div>
  );
}
