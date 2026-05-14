'use client';

import { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

interface Props {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  /**
   * Hide the back button on this page. Use only for top-level landing
   * surfaces with no meaningful parent (e.g. Overview). Default: shown.
   */
  hideBack?: boolean;
}

/**
 * Back button is shown on every page except the root overview. Uses
 * `router.back()` so the browser history is respected; on a direct hit
 * (deep link, refresh on a sub-page) it falls back to the parent path
 * derived from the current pathname.
 */
export function PageHeader({ title, subtitle, action, hideBack }: Props): JSX.Element {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const showBack = !hideBack && pathname !== '/' && pathname !== '/overview';

  const onBack = (): void => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    const parts = pathname.split('/').filter(Boolean);
    const parent = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/overview';
    router.push(parent);
  };

  return (
    <header className="flex items-end justify-between gap-4 flex-wrap">
      <div className="flex items-start gap-3">
        {showBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Go back"
            className="mt-1 inline-flex items-center justify-center h-7 w-7 rounded-md border border-line2 text-muted hover:text-ink hover:bg-surface2 hover:border-line transition"
          >
            <ChevronLeft size={15} />
          </button>
        )}
        <div>
          <h1 className="text-ink text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
        </div>
      </div>
      {action}
    </header>
  );
}
