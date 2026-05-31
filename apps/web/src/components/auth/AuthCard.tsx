/**
 * AuthCard — the centered surface card used by every unauthenticated
 * page (login, MFA, accept-invitation, forgot-password, reset-password).
 *
 * Locks in the shared geometry so each surface feels like a single
 * product family:
 *   - centered vertically + horizontally on a `bg-paper` viewport
 *   - max-width 400px (form column), 380-420px range per spec
 *   - `bg-surface` card with `border-line` 1px stroke + soft shadow
 *   - generous padding (px-8 py-9) for breathing room
 *   - `BrandMark` slot above, `TrustLine` slot below
 *   - gentle fade-in on mount via the shared `motion-page-in` utility
 *     (defined in `components/motion/motion.css`) — respects
 *     `prefers-reduced-motion`
 *
 * Server component. Pages render their own form inside.
 */
import type { JSX, ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { TrustLine } from './TrustLine';

interface AuthCardProps {
  children: ReactNode;
  /** Optional element rendered above the form (e.g. brand hero for /login). */
  aside?: ReactNode;
  /** Hide the trust line — only for cases where the surface already shows it. */
  hideTrustLine?: boolean;
}

export function AuthCard({ children, aside, hideTrustLine = false }: AuthCardProps): JSX.Element {
  return (
    <div className="min-h-screen bg-paper flex">
      {aside}
      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-[400px] motion-page-in">
          <div className="mb-8 lg:mb-10">
            <BrandMark variant="stacked" />
          </div>
          <div className="bg-surface border border-line rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] px-7 py-8 sm:px-8 sm:py-9">
            {children}
          </div>
          {!hideTrustLine && <TrustLine className="mt-6" />}
        </div>
      </main>
    </div>
  );
}
