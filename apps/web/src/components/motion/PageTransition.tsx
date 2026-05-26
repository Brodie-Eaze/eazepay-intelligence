'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Fade + 4px upward translate (200ms ease-out) on route mount. Wrap a
 * page's body so navigation feels intentional rather than instantaneous.
 *
 * SSR-safe: the class is rendered identically on server + client. The
 * animation runs on each mount; keying on `usePathname()` ensures the
 * element re-mounts (and re-animates) on every client-side navigation,
 * not just the first paint.
 *
 * Reduced-motion: handled in motion.css (animation collapses to 1ms).
 *
 * @example
 *   export default function Page() {
 *     return (
 *       <PageTransition>
 *         <Dashboard />
 *       </PageTransition>
 *     );
 *   }
 */
export function PageTransition({ children }: { children: ReactNode }): JSX.Element {
  const pathname = usePathname();
  return (
    <div key={pathname} className="motion-page-in">
      {children}
    </div>
  );
}
