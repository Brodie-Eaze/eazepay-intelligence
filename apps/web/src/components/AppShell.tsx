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
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar wsConnected={connected} />
          <main ref={mainRef} className="flex-1 p-6 lg:p-8 overflow-auto bg-paper">
            {children}
          </main>
        </div>
      </div>
    </LiveTickerContext.Provider>
  );
}
