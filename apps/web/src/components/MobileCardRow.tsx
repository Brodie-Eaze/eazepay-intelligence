'use client';

/**
 * Reusable building block for "table → stacked cards" mobile collapse.
 *
 * Pattern: every table in the dashboard pairs a desktop `<table>`
 * (wrapped in `hidden md:block`) with a stack of these cards (wrapped
 * in `md:hidden`). Pick the 2–3 most important fields per row.
 *
 * Targeted breakpoints: < md (< 768px) only.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';

interface Field {
  label: string;
  value: ReactNode;
  /** Right-align the value (numerics, money). */
  align?: 'left' | 'right';
}

interface MobileCardRowProps {
  /** Optional href turns the whole card into a tappable link. */
  href?: string;
  /** Primary heading line (large, ink). */
  title: ReactNode;
  /** Optional small line under the title. */
  subtitle?: ReactNode;
  /** Optional badge/pill rendered top-right (status, risk band, etc). */
  badge?: ReactNode;
  /** Up to ~4 key fields, rendered in a 2-col grid. */
  fields?: Field[];
  /** Footer slot — typically a timestamp or single action. */
  footer?: ReactNode;
}

export function MobileCardRow({
  href,
  title,
  subtitle,
  badge,
  fields,
  footer,
}: MobileCardRowProps): JSX.Element {
  const inner = (
    <div className="card px-4 py-3 flex flex-col gap-2 min-h-[44px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink tracking-tight truncate">{title}</div>
          {subtitle && (
            <div className="text-[11px] text-muted mt-0.5 truncate">{subtitle}</div>
          )}
        </div>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>
      {fields && fields.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-1 border-t border-line2">
          {fields.map((f, i) => (
            <div key={i} className={f.align === 'right' ? 'text-right' : ''}>
              <div className="text-[10px] uppercase tracking-[0.10em] text-muted font-medium">
                {f.label}
              </div>
              <div className="text-[13px] text-ink2 numeric truncate">{f.value}</div>
            </div>
          ))}
        </div>
      )}
      {footer && (
        <div className="text-[11px] text-muted pt-1 border-t border-line2">{footer}</div>
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl">
        {inner}
      </Link>
    );
  }
  return inner;
}

export function MobileCardList({ children }: { children: ReactNode }): JSX.Element {
  return <div className="md:hidden space-y-2 px-4 py-3">{children}</div>;
}
