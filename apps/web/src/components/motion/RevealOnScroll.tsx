'use client';

import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';

interface RevealOnScrollProps {
  children: ReactNode;
  /** rootMargin passed to IntersectionObserver. */
  rootMargin?: string;
  /** Optional className applied to the wrapper. */
  className?: string;
  /** Render the wrapper as this tag. Defaults to `div`. */
  as?: 'div' | 'section' | 'article';
}

/**
 * When the wrapper enters the viewport, its content fades + translates
 * up 12px (once only — never re-animates on scroll-back). Backed by
 * `IntersectionObserver` so it costs nothing while off-screen.
 *
 * SSR-safe: server renders the wrapper with `data-revealed="false"`
 * (the at-rest state in CSS). On the client, the observer flips the
 * attribute when the element intersects.
 *
 * Reduced-motion: handled in motion.css (forces revealed state, no
 * transition).
 *
 * @example
 *   <RevealOnScroll>
 *     <ChartSection />
 *   </RevealOnScroll>
 */
export function RevealOnScroll({
  children,
  rootMargin = '0px 0px -10% 0px',
  className,
  as: Tag = 'div',
}: RevealOnScrollProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // No IntersectionObserver (very old browsers / certain test envs) —
    // reveal immediately so content is never trapped invisible.
    if (typeof IntersectionObserver === 'undefined') {
      setRevealed(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin, threshold: 0.05 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [rootMargin]);

  return createElement(
    Tag,
    {
      ref,
      'data-revealed': revealed ? 'true' : 'false',
      className: `motion-reveal ${className ?? ''}`.trim(),
    },
    children,
  );
}
