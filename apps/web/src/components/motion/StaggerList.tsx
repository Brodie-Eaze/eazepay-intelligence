'use client';

import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

interface StaggerListProps {
  children: ReactNode;
  /** Delay between consecutive children, in ms. Defaults to 40ms. */
  stagger?: number;
  /** Delay applied before the first child animates in, in ms. */
  initialDelay?: number;
  /** Max number of children to animate. Beyond this, items render with
   *  no delay (no animation class). Prevents the 200th table row from
   *  arriving 8 seconds late. */
  maxAnimated?: number;
  /** Optional className applied to the wrapper. */
  className?: string;
  /** Render the wrapper as this tag. Defaults to `div`. */
  as?: 'div' | 'ul' | 'ol' | 'nav' | 'tbody';
}

type ChildWithProps = ReactElement<{ className?: string; style?: React.CSSProperties }>;

/**
 * Renders each direct child with a fade + 8px upward translate,
 * staggered 40ms apart. Use for card grids, sidebar nav, or table rows
 * on FIRST render — not for subsequent paginations.
 *
 * Animation runs via CSS class `motion-stagger-item` + an inline
 * `animationDelay`. SSR-safe: classes + styles are deterministic on
 * both sides of the hydration boundary.
 *
 * Reduced-motion: handled in motion.css (1ms duration).
 *
 * @example
 *   <StaggerList>
 *     {cards.map((c) => <Card key={c.id} {...c} />)}
 *   </StaggerList>
 *
 * @example
 *   <StaggerList as="tbody" stagger={25} maxAnimated={20}>
 *     {rows.map((r) => <tr key={r.id}>...</tr>)}
 *   </StaggerList>
 */
export function StaggerList({
  children,
  stagger = 40,
  initialDelay = 0,
  maxAnimated = 30,
  className,
  as: Tag = 'div',
}: StaggerListProps): JSX.Element {
  const items = Children.toArray(children);

  return (
    <Tag className={className}>
      {items.map((child, i) => {
        if (!isValidElement(child)) return child;
        const el = child as ChildWithProps;
        if (i >= maxAnimated) return el;
        const existingClass = el.props.className ?? '';
        const existingStyle = el.props.style ?? {};
        return cloneElement(el, {
          className: `${existingClass} motion-stagger-item`.trim(),
          style: {
            ...existingStyle,
            animationDelay: `${initialDelay + i * stagger}ms`,
          },
        });
      })}
    </Tag>
  );
}
