/**
 * BrandMark — the EazePay Intelligence wordmark used on unauthenticated
 * surfaces (login, accept-invitation, etc.).
 *
 * Type-only treatment in `ink`. Pairs `EazePay` (semibold) with the
 * `INTELLIGENCE` eyebrow in `accent`. The component is intentionally
 * server-renderable (no `'use client'`) so it ships zero JS.
 *
 * Variants:
 *   - `stacked`  (default) — wordmark on top, eyebrow below; centered.
 *                Used above forms on narrow surfaces.
 *   - `inline`   — wordmark + eyebrow on one baseline; aligned left.
 *                 Used inside the brand hero column on /login.
 *
 * The tone-on-light + accent-eyebrow combination is the platform's
 * locked treatment (see DESIGN.md). Do not parameterise colour here.
 */
import type { JSX } from 'react';

interface BrandMarkProps {
  variant?: 'stacked' | 'inline';
  /** Optional override for the wordmark size class. Defaults vary by variant. */
  className?: string;
}

export function BrandMark({ variant = 'stacked', className }: BrandMarkProps): JSX.Element {
  if (variant === 'inline') {
    return (
      <div className={`flex items-baseline gap-2 ${className ?? ''}`.trim()}>
        <span className="font-semibold tracking-tight text-2xl text-surface">EazePay</span>
        <span className="text-accent text-[11px] font-semibold tracking-[0.18em]">
          INTELLIGENCE
        </span>
      </div>
    );
  }
  return (
    <div className={`text-center ${className ?? ''}`.trim()}>
      <div className="font-semibold tracking-tight text-ink text-2xl">EazePay</div>
      <div className="text-accent text-[11px] font-semibold tracking-[0.18em] mt-1">
        INTELLIGENCE
      </div>
    </div>
  );
}
