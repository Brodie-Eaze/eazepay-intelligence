/**
 * AuthError — inline error banner for auth forms.
 *
 * Renders with `role="alert"` + `aria-live="assertive"` so screen
 * readers announce the failure as soon as the server (or client-side
 * validation) rejects the submission. Visual styling uses
 * `border-line2` + `bg-paper` for a calm, non-alarming presentation —
 * we want users to recover, not panic.
 *
 * The `ink` text colour is deliberate: this is a regulated-platform
 * surface and red banners read as consumer-grade. Trust is conveyed by
 * specificity of the message, not by alarm colour.
 *
 * Voice rules (Sprint D): sentence case, no exclamation, no "please".
 * Pages should pass server-mapped messages here unchanged.
 */
import type { JSX } from 'react';

export function AuthError({ message }: { message: string }): JSX.Element {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="text-[13px] text-ink border border-line bg-paper px-3 py-2 rounded-lg"
    >
      {message}
    </div>
  );
}
