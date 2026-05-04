'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/lib/auth';
import { useAnalyticsWebSocket } from '@/lib/ws';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { LiveTickerContext } from './LiveTickerContext';

export function AppShell({ children }: { children: React.ReactNode }): JSX.Element {
  const user = useUser();
  const router = useRouter();
  const { connected, events } = useAnalyticsWebSocket();

  useEffect(() => {
    if (!user) router.replace('/login');
  }, [user, router]);

  if (!user) return <div />;

  return (
    <LiveTickerContext.Provider value={{ events, connected }}>
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar wsConnected={connected} />
          <main className="flex-1 p-6 lg:p-8 overflow-auto bg-paper">{children}</main>
        </div>
      </div>
    </LiveTickerContext.Provider>
  );
}
