'use client';

import { useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useUser } from '@/lib/auth';
import { useAnalyticsWebSocket } from '@/lib/ws';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { LiveTickerContext } from './LiveTickerContext';

export function AppShell({ children }: { children: React.ReactNode }): JSX.Element {
  const user = useUser();
  const router = useRouter();
  const path = usePathname();
  const { connected, events } = useAnalyticsWebSocket();
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!user) router.replace('/login');
  }, [user, router]);

  // The actual scroll container in this layout is <main>, not window.
  // Next.js Link's default `scroll: true` resets window scroll, but the
  // window never scrolled to begin with — the inner <main> did. Reset
  // it on every route change so each page opens at the top instead of
  // inheriting the previous page's scroll offset.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [path]);

  if (!user) return <div />;

  return (
    <LiveTickerContext.Provider value={{ events, connected }}>
      {/*
       * `h-screen` (not min-h-screen) pins the shell to the viewport so
       * the window itself never scrolls. The sidebar and main each have
       * their own `overflow-y-auto` and scroll independently. Without
       * this, a tall sidebar (10+ nav groups) pushes the window's body
       * height past viewport, and every route change resets window
       * scroll — which yanks the sidebar back to the top.
       */}
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar wsConnected={connected} />
          <main ref={mainRef} className="flex-1 p-6 lg:p-8 overflow-y-auto bg-paper">
            {children}
          </main>
        </div>
      </div>
    </LiveTickerContext.Provider>
  );
}
