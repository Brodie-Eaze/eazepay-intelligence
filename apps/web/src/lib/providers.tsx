'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { AuthContext } from './auth';
import { api } from './api';
import type { SessionResponse } from './types';

/**
 * Public paths that don't need an authenticated session. The auth probe is
 * skipped on these so the Loading gate doesn't hang forever when the API
 * is slow / unreachable, and so they don't require a session at all.
 *
 * Match by `startsWith` so nested sub-routes inherit (e.g.
 * `/engineering-reference/anything`).
 */
const PUBLIC_PATH_PREFIXES = ['/engineering-reference'];

function isPublicPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function Providers({ children }: { children: ReactNode }): JSX.Element {
  const pathname = usePathname();
  const skipAuthProbe = isPublicPath(pathname);

  const [session, setSession] = useState<SessionResponse | null>(null);
  // On public paths, treat as immediately hydrated so children render
  // without waiting on the /auth/me round-trip. The Providers tree still
  // mounts (QueryClient etc.) so children that DO need queries can issue
  // them — they just don't gate on a session.
  const [hydrated, setHydrated] = useState(skipAuthProbe);

  useEffect(() => {
    if (skipAuthProbe) return;
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
  }, [skipAuthProbe]);

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
