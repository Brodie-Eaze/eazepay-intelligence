'use client';

import { useEffect, useState } from 'react';

/**
 * One-shot welcome banner shown on /overview until the operator dismisses
 * it. Dismissal is sessionStorage-scoped so it returns next browser session
 * — intentional: re-orients returning operators after a context switch
 * without nagging within a single session.
 */

const STORAGE_KEY = 'eaze.firstRun.overview.dismissed';

export interface FirstRunBannerProps {
  title: string;
  description: string;
  /** Optional override of the storage key (per-surface banners). */
  storageKey?: string;
}

export function FirstRunBanner({
  title,
  description,
  storageKey,
}: FirstRunBannerProps): JSX.Element | null {
  const key = storageKey ?? STORAGE_KEY;
  // Render nothing on the server / first paint to avoid hydration mismatch;
  // sessionStorage is only available client-side.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(key) !== '1') setVisible(true);
    } catch {
      // sessionStorage blocked (private mode, etc.) — show once per mount.
      setVisible(true);
    }
  }, [key]);

  if (!visible) return null;

  const dismiss = (): void => {
    try {
      sessionStorage.setItem(key, '1');
    } catch {
      // ignore — we still hide it for this mount
    }
    setVisible(false);
  };

  return (
    <div
      role="status"
      className="relative rounded-xl border border-accentSoft bg-accentSoft/40 px-5 py-4 flex items-start gap-4"
    >
      <div
        className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-surface text-accent border border-accentSoft"
        aria-hidden
      >
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-ink tracking-tight">{title}</div>
        <p className="text-xs text-muted mt-1 leading-relaxed max-w-2xl">{description}</p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss welcome banner"
        className="flex-shrink-0 text-soft hover:text-ink transition -mr-1 -mt-1 p-1"
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  );
}
