'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Tick a number up from 0 to `value` over `duration` ms with an
 * ease-out cubic curve. Re-runs when `value` changes (animates from
 * the previous value, not from zero — feels like a real-time tick).
 *
 * Used in the Overview hero to make "AUD 1,442,374" feel like a live
 * number that responded to your arrival.
 */
export function CountUp({
  value,
  duration = 900,
  formatter,
  className,
}: {
  value: number;
  duration?: number;
  formatter: (n: number) => string;
  className?: string;
}): JSX.Element {
  const [display, setDisplay] = useState(value);
  const from = useRef(value);
  const start = useRef<number | null>(null);

  useEffect(() => {
    from.current = display;
    start.current = null;
    let raf = 0;
    const step = (ts: number): void => {
      if (start.current === null) start.current = ts;
      const elapsed = ts - start.current;
      const t = Math.min(1, elapsed / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from.current + (value - from.current) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);

  return <span className={className}>{formatter(display)}</span>;
}
