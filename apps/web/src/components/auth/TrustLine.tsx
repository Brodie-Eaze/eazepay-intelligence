/**
 * TrustLine — single-line credibility marker for unauthenticated surfaces.
 *
 * Rendered below an auth form to set the tone that the user is on a
 * regulated-grade platform. Intentionally minimal — three signals,
 * separated by mid-dots, in `text-soft text-xs`. The first signal a
 * lender sees on the platform: this matters more than any in-app footer.
 *
 * Voice: matches Sprint D — sentence case, no exclamation, no "please".
 * Wording mirrors the in-app SecurityFooter so the platform reads
 * consistently from sign-in through to overview.
 *
 * Server component (no client JS).
 */
import type { JSX } from 'react';

const SIGNALS: ReadonlyArray<string> = [
  'SOC 2 Type II in progress',
  'AES-256 encryption',
  'TLS 1.3',
];

export function TrustLine({ className }: { className?: string }): JSX.Element {
  return (
    <p
      className={`text-soft text-xs text-center leading-relaxed ${className ?? ''}`.trim()}
      // Decorative — already conveyed by the in-app security footer for
      // signed-in users. Keep out of the a11y tree to reduce noise for
      // screen-reader users on the form.
      aria-hidden="true"
    >
      {SIGNALS.join(' · ')}
    </p>
  );
}
