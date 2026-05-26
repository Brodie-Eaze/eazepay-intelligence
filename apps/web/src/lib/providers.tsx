'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { AuthContext } from './auth';
import { api } from './api';
import type { SessionResponse } from './types';

export function Providers({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await api<SessionResponse['user']>('/auth/me');
        if (!cancelled) {
          setSession({
            user: me,
            csrfToken: '',
            accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          });
        }
      } catch {
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
    [],
  );

  if (!hydrated) {
    return <div className="min-h-screen flex items-center justify-center text-muted">Loading…</div>;
  }

  return (
    <AuthContext.Provider value={{ session, setSession }}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </AuthContext.Provider>
  );
}
