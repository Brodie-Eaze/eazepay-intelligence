'use client';

/**
 * Sidebar for the public /platform landing page.
 *
 * Client component because it runs an IntersectionObserver to highlight
 * the section currently nearest the top of the viewport. Falls back to
 * static markup during SSR — no hydration mismatch.
 */
import { useEffect, useMemo, useState } from 'react';

export interface PlatformNavItem {
  id: string;
  label: string;
  numeral: string;
}

interface PlatformSidebarProps {
  items: ReadonlyArray<PlatformNavItem>;
  buildSha: string;
}

export function PlatformSidebar({ items, buildSha }: PlatformSidebarProps): JSX.Element {
  const allIds = useMemo(() => items.map((i) => i.id), [items]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;

    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) {
            visible.set(id, entry.boundingClientRect.top);
          } else {
            visible.delete(id);
          }
        }
        if (visible.size === 0) return;
        let bestId: string | null = null;
        let bestTop = Number.POSITIVE_INFINITY;
        for (const [id, top] of visible) {
          if (top < bestTop) {
            bestTop = top;
            bestId = id;
          }
        }
        setActiveId(bestId);
      },
      { rootMargin: '-15% 0% -75% 0%', threshold: 0 },
    );

    const observed: Element[] = [];
    for (const id of allIds) {
      const el = document.getElementById(id);
      if (el) {
        observer.observe(el);
        observed.push(el);
      }
    }
    return () => {
      for (const el of observed) observer.unobserve(el);
      observer.disconnect();
    };
  }, [allIds]);

  const linkBase =
    'flex items-start gap-2 text-xs py-2 px-1 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2';
  const linkIdle = 'text-slate-700 hover:text-slate-900';
  const linkActive = 'text-accent font-semibold';

  return (
    <aside
      aria-label="Platform page sections"
      className="hidden lg:block w-72 shrink-0 sticky top-0 self-start h-screen overflow-y-auto py-8 px-6 border-r border-line bg-white"
    >
      <div className="mb-8">
        <h2 className="text-base font-bold text-slate-900 tracking-tight">Eaze Intelligence</h2>
        <p className="text-[10px] uppercase tracking-wider text-slate-600 mt-1">
          Platform · {buildSha}
        </p>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold mb-3">
          On this page
        </div>
        <nav className="space-y-0.5">
          {items.map((item) => {
            const isActive = activeId === item.id;
            return (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={isActive ? 'true' : undefined}
                className={`${linkBase} ${isActive ? linkActive : linkIdle}`}
              >
                <span className="text-slate-400 font-mono">{item.numeral}</span>
                <span className={isActive ? 'font-semibold' : 'font-medium'}>{item.label}</span>
              </a>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
