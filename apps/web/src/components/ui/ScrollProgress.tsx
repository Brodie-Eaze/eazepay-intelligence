'use client';

/**
 * 1px accent-coloured progress bar fixed at the top of the viewport.
 * Fills horizontally as the user scrolls the document.
 */
import { useEffect, useRef } from 'react';

export function ScrollProgress(): JSX.Element {
  const fillRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let ticking = false;

    const update = (): void => {
      ticking = false;
      const el = fillRef.current;
      if (!el) return;
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const pct = max > 0 ? Math.min(1, Math.max(0, doc.scrollTop / max)) : 0;
      el.style.transform = `scaleX(${pct})`;
    };

    const onScroll = (): void => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <div aria-hidden="true" className="fixed top-0 left-0 right-0 h-px z-50 pointer-events-none">
      <div
        ref={fillRef}
        className="h-full w-full bg-accent origin-left"
        style={{ transform: 'scaleX(0)' }}
      />
    </div>
  );
}
