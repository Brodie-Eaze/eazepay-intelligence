/**
 * AuthField — labelled form field primitive for auth surfaces.
 *
 * Wraps children in a `<label>` so clicking the label focuses the
 * input. Optional `right` slot for utility links (e.g. "Forgot?").
 *
 * Server component. The actual `<input>` is rendered by the caller —
 * this gives pages full control over `type`, `autoComplete`, and any
 * one-off styling (e.g. monospace + tracking on MFA codes) while still
 * locking in label typography across every auth page.
 *
 * A11y:
 *   - `<label>` wrap means no `htmlFor`/`id` plumbing required
 *   - `aria-describedby` consumers can pass a hint id via the children
 *
 * Sizing: `mb-1.5` between label and field, matching the prior inline
 * implementations in /login and /accept-invitation.
 */
import type { JSX, ReactNode } from 'react';

interface AuthFieldProps {
  label: string;
  right?: ReactNode;
  children: ReactNode;
}

export function AuthField({ label, right, children }: AuthFieldProps): JSX.Element {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] font-medium text-ink2 tracking-tight">{label}</span>
        {right}
      </div>
      {children}
    </label>
  );
}

/**
 * Shared input class string. Tokens only — no hex literals. Centralised
 * so every auth surface gets the same height, focus ring, and border
 * treatment. Pages can append additional classes (e.g. `pr-11` for an
 * icon-button slot).
 *
 * Focus ring: 2px `accent` ring + 2px `paper` offset → satisfies WCAG
 * AA visible-focus, calm on light paper background.
 */
export const AUTH_INPUT_CLASS =
  'w-full bg-surface border border-line rounded-lg px-4 h-11 text-[15px] text-ink ' +
  'placeholder:text-soft outline-none transition ' +
  'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper';

/**
 * Shared submit-button class string. Pairs with `bg-ink` primary CTA.
 * Pages render their own `<button>` so they can compose icon + label
 * + loading state without prop-drilling.
 */
export const AUTH_PRIMARY_BUTTON_CLASS =
  'w-full h-11 rounded-lg bg-ink text-surface font-medium tracking-tight text-[15px] ' +
  'hover:bg-ink2 disabled:opacity-50 disabled:cursor-not-allowed transition ' +
  'flex items-center justify-center gap-2 group ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface';
