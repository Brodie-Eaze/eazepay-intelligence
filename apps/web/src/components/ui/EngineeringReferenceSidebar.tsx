'use client';

/**
 * Sidebar for the engineering-reference page.
 *
 * Client component so it can run an IntersectionObserver and highlight the
 * section currently nearest the top of the viewport.
 */
import { useEffect, useMemo, useState } from 'react';

export interface SidebarItem {
  id: string;
  label: string;
  numeral: string;
}

interface EngineeringReferenceSidebarProps {
  flowItems: SidebarItem[];
  referenceItems: SidebarItem[];
  buildSha: string;
}

export function EngineeringReferenceSidebar({
  flowItems,
  referenceItems,
  buildSha,
}: EngineeringReferenceSidebarProps): JSX.Element {
  const allIds = useMemo(
    () => [...flowItems.map((i) => i.id), ...referenceItems.map((i) => i.id)],
    [flowItems, referenceItems],
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;

    // Track which sections are currently intersecting. Pick the one nearest
    // the top of the viewport. Root-margin biases the "active" band toward
    // the upper 15-25% of the viewport.
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
      {
        rootMargin: '-15% 0% -75% 0%',
        threshold: 0,
      },
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
    <aside className="w-72 shrink-0 sticky top-0 self-start h-screen overflow-y-auto py-8 px-6 border-r border-line bg-white">
      <div className="mb-8">
        <h1 className="text-base font-bold text-slate-900 tracking-tight">Eaze Intelligence</h1>
        <p className="text-[10px] uppercase tracking-wider text-slate-600 mt-1">
          Flow + reference · {buildSha}
        </p>
      </div>

      <div className="space-y-6">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold mb-3">
            A · Data Flow
          </div>
          <nav className="space-y-0.5">
            {flowItems.map((item) => {
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

        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold mb-3">
            B · Reference
          </div>
          <nav className="space-y-0.5">
            {referenceItems.map((item) => {
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
      </div>
    </aside>
  );
}
