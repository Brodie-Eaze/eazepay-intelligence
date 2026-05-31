'use client';

/**
 * Mobile-only top app bar + slide-in drawer for primary nav.
 *
 * Breakpoint policy:
 *   - Visible at < md (< 768px) only. Above md, the desktop Sidebar
 *     renders instead.
 *
 * Behaviour:
 *   - Hamburger toggles drawer overlay.
 *   - Drawer auto-closes on route change.
 *   - Esc + scrim click close.
 *   - When closed, drawer has `aria-hidden` + is removed from tab order.
 *   - Touch targets ≥44px (h-11) per iOS HIG.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { useUser } from '@/lib/auth';
import { Sidebar } from './Sidebar';

export function MobileNav(): JSX.Element {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const user = useUser();

  // Close on route change.
  useEffect(() => {
    setOpen(false);
  }, [path]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    // Lock body scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="md:hidden">
      {/* Top app bar */}
      <header className="h-14 border-b border-line2 px-4 flex items-center justify-between bg-surface sticky top-0 z-20">
        <button
          type="button"
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          onClick={() => setOpen(true)}
          className="inline-flex items-center justify-center h-11 w-11 -ml-2 rounded-md text-ink2 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Menu size={22} strokeWidth={1.75} />
        </button>
        <Link href="/overview" className="flex flex-col items-center leading-none">
          <span className="font-semibold tracking-tight text-ink text-[15px]">EazePay</span>
          <span className="text-accent text-[9px] font-semibold tracking-[0.18em] mt-0.5">
            INTELLIGENCE
          </span>
        </Link>
        <div className="h-11 w-11 inline-flex items-center justify-center">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-ink text-surface text-[11px] font-semibold tracking-tight">
            {(user?.email ?? '??').slice(0, 2).toUpperCase()}
          </span>
        </div>
      </header>

      {/* Scrim */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={`fixed inset-0 bg-ink/40 backdrop-blur-sm z-40 transition-opacity ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      {/* Drawer */}
      <div
        id="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Primary navigation"
        aria-hidden={!open}
        className={`fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] bg-surface shadow-xl transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between h-14 px-3 border-b border-line2">
          <Link
            href="/overview"
            className="block px-2"
            tabIndex={open ? 0 : -1}
            onClick={() => setOpen(false)}
          >
            <div className="font-semibold tracking-tight text-ink text-[15px] leading-none">
              EazePay
            </div>
            <div className="text-accent text-[9px] font-semibold tracking-[0.18em] mt-1">
              INTELLIGENCE
            </div>
          </Link>
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setOpen(false)}
            tabIndex={open ? 0 : -1}
            className="inline-flex items-center justify-center h-11 w-11 rounded-md text-ink2 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={20} strokeWidth={1.75} />
          </button>
        </div>
        {/* Reuse desktop sidebar contents — it already renders nav.
            We override width via wrapper so the inner aside fills. */}
        <div className="h-[calc(100vh-3.5rem)] overflow-hidden flex">
          {/* tabIndex restraint handled by aria-hidden on drawer */}
          <Sidebar />
        </div>
      </div>
    </div>
  );
}
