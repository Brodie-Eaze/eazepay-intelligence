'use client';

import { useEffect, useState } from 'react';

/**
 * Returns `true` when the OS-level `prefers-reduced-motion: reduce` media
 * query matches. SSR-safe — always returns `false` on the server and on
 * the first client render, then flips on the effect tick if the user
 * prefers reduced motion. Every motion primitive in this folder MUST
 * short-circuit to instant when this returns `true`.
 *
 * @example
 *   const reduced = usePrefersReducedMotion();
 *   if (reduced) return <>{children}</>;
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
