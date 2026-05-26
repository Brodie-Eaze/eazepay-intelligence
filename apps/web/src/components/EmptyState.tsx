'use client';

import * as React from 'react';
import type { ReactNode } from 'react';

/**
 * Empty-state primitive. Replaces generic "No data" rows across every
 * dashboard surface with an intentional, brand-locked block that tells
 * the operator (a) why the surface is empty and (b) what to do about it.
 *
 * Variants encode the *reason* the surface is empty — the icon, border
 * treatment, and default tone all shift accordingly:
 *
 *   firstRun    — surface has never been used; show a welcoming primer.
 *   filterEmpty — data exists but the current filter/range hides it.
 *   searchEmpty — search query returned zero hits.
 *   error       — fetch failed; show a recovery affordance.
 *
 * Brand-locked to Eaze tokens (paper, surface, ink, accent, accentSoft,
 * line, line2, muted, soft). Icons are inline SVG — no new deps.
 */

export type EmptyStateVariant = 'firstRun' | 'filterEmpty' | 'searchEmpty' | 'error';

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface EmptyStateProps {
  variant: EmptyStateVariant;
  title: string;
  description?: ReactNode;
  /** Override the variant's default icon. */
  icon?: ReactNode;
  primaryAction?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /** Render inside a table cell — drops the outer card chrome. */
  inline?: boolean;
  className?: string;
}

export function EmptyState({
  variant,
  title,
  description,
  icon,
  primaryAction,
  secondaryAction,
  inline,
  className,
}: EmptyStateProps): JSX.Element {
  const resolvedIcon = icon ?? DEFAULT_ICON[variant];
  const tone = TONE[variant];

  const body = (
    <div
      className={`flex flex-col items-center text-center px-6 py-10 ${className ?? ''}`}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      <div
        className={`flex items-center justify-center w-12 h-12 rounded-full ${tone.iconBg} ${tone.iconFg} mb-4`}
        aria-hidden
      >
        {resolvedIcon}
      </div>
      <h3 className="text-sm font-semibold text-ink tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted mt-1.5 max-w-sm leading-relaxed">{description}</p>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="flex items-center gap-2 mt-4">
          {primaryAction && <ActionButton action={primaryAction} kind="primary" />}
          {secondaryAction && <ActionButton action={secondaryAction} kind="secondary" />}
        </div>
      )}
    </div>
  );

  if (inline) return body;

  return <div className={`rounded-lg border border-dashed ${tone.border} bg-paper/40`}>{body}</div>;
}

function ActionButton({
  action,
  kind,
}: {
  action: EmptyStateAction;
  kind: 'primary' | 'secondary';
}): JSX.Element {
  const cls =
    kind === 'primary'
      ? 'px-3 py-1.5 rounded-md bg-ink text-surface text-xs font-medium hover:bg-ink2 transition'
      : 'px-3 py-1.5 rounded-md border border-line text-ink2 text-xs font-medium hover:bg-surface transition';
  if (action.href) {
    return (
      <a href={action.href} className={cls}>
        {action.label}
      </a>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={cls}>
      {action.label}
    </button>
  );
}

const TONE: Record<EmptyStateVariant, { border: string; iconBg: string; iconFg: string }> = {
  firstRun: { border: 'border-accentSoft', iconBg: 'bg-accentSoft', iconFg: 'text-accent' },
  filterEmpty: { border: 'border-line', iconBg: 'bg-line2', iconFg: 'text-muted' },
  searchEmpty: { border: 'border-line', iconBg: 'bg-line2', iconFg: 'text-muted' },
  error: { border: 'border-line', iconBg: 'bg-line2', iconFg: 'text-ink' },
};

const ICON_SIZE = 22;

const DEFAULT_ICON: Record<EmptyStateVariant, JSX.Element> = {
  firstRun: (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="m4.93 4.93 2.83 2.83" />
      <path d="m16.24 16.24 2.83 2.83" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
      <path d="m4.93 19.07 2.83-2.83" />
      <path d="m16.24 7.76 2.83-2.83" />
    </svg>
  ),
  filterEmpty: (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4h18l-7 9v6l-4 2v-8L3 4z" />
    </svg>
  ),
  searchEmpty: (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  error: (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </svg>
  ),
};
