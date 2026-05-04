'use client';

import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { WebsocketBadge } from './WebsocketBadge';

interface Props {
  wsConnected: boolean;
  title?: string;
}

export function TopBar({ wsConnected, title }: Props): JSX.Element {
  const { session, setSession } = useAuth();
  const router = useRouter();

  const logout = async (): Promise<void> => {
    await api('/auth/logout', { method: 'POST', body: '{}' });
    setSession(null);
    router.replace('/login');
  };

  const initials = (session?.user.email ?? '??').slice(0, 2).toUpperCase();

  return (
    <header className="h-14 border-b border-line2 px-6 flex items-center justify-between bg-surface/95 backdrop-blur sticky top-0 z-10">
      <div className="flex items-center gap-3">
        {title && <span className="text-sm font-semibold text-ink tracking-tight">{title}</span>}
        <span className="pill pill-muted text-[10px] uppercase tracking-wider">
          {process.env.NEXT_PUBLIC_ENV ?? 'local'}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <WebsocketBadge connected={wsConnected} />
        <div className="flex items-center gap-2">
          <span className="mono">{initials}</span>
          <div className="text-xs leading-tight">
            <div className="font-medium text-ink">{session?.user.email}</div>
            <div className="text-muted">{session?.user.role}</div>
          </div>
        </div>
        <button onClick={logout} className="text-xs text-muted hover:text-ink transition">Sign out</button>
      </div>
    </header>
  );
}
