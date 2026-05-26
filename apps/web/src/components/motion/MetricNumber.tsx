'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

interface MetricNumberProps {
  /** Target value. Animates to this number. */
  value: number;
  /** Animation duration in ms. Defaults to 800ms. */
  duration?: number;
  /** Format the displayed value. Defaults to integer with no separators. */
  formatter?: (n: number) => string;
  className?: string;
}

/**
 * Counts up from 0 → `value` over 800ms on first mount, then animates
 * from previous → next whenever `value` actually changes. Uses the
 * `cubic-bezier(0.4, 0, 0.2, 1)` curve (Material standard ease).
 *
 * SSR-safe: first server render emits the formatted target value (so
 * crawlers and no-JS users see the real number). On client mount, the
 * animation jumps to 0 and ticks up — there's a single-frame swap but
 * no hydration mismatch because the DOM string is identical at hydrate
 * time.
 *
 * Reduced-motion: short-circuits to the final value immediately.
 *
 * @example
 *   <MetricNumber value={1442374} formatter={formatMoney} />
 *
 * @example
 *   <MetricNumber value={48} duration={600} className="text-3xl tabular-nums" />
 */
export function MetricNumber({
  value,
  duration = 800,
  formatter = (n) => Math.round(n).toLocaleString(),
  className,
}: MetricNumberProps): JSX.Element {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState<number>(value);
  const fromRef = useRef<number>(0);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      fromRef.current = value;
      hasMountedRef.current = true;
      return;
    }

    // On first mount: animate 0 → value. On value change: animate
    // previous → next.
    const from = hasMountedRef.current ? fromRef.current : 0;
    const to = value;

    if (from === to) {
      setDisplay(to);
      hasMountedRef.current = true;
      return;
    }

    let raf = 0;
    let start: number | null = null;
    // cubic-bezier(0.4, 0, 0.2, 1) approximation via cubic ease-in-out
    const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = (ts: number): void => {
      if (start === null) start = ts;
      const elapsed = ts - start;
      const t = Math.min(1, elapsed / duration);
      setDisplay(from + (to - from) * ease(t));
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
        hasMountedRef.current = true;
      }
    };

    setDisplay(from);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);

  return <span className={className}>{formatter(display)}</span>;
}
