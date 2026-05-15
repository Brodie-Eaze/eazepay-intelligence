'use client';

import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { WebsocketBadge } from './WebsocketBadge';
import { CommandPalette, useCommandPalette } from './CommandPalette';

interface Props {
  wsConnected: boolean;
  title?: string;
}

const ENV_COLOR: Record<string, string> = {
  local: 'bg-slate-500/10 text-slate-600 border-slate-500/30',
  dev: 'bg-blue-500/10 text-blue-700 border-blue-500/30',
  staging: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  production: 'bg-rose-500/10 text-rose-700 border-rose-500/30',
};

export function TopBar({ wsConnected, title }: Props): JSX.Element {
  const { session, setSession } = useAuth();
  const router = useRouter();
  const palette = useCommandPalette();

  const logout = async (): Promise<void> => {
    await api('/auth/logout', { method: 'POST', body: '{}' });
    setSession(null);
    router.replace('/login');
  };

  const env = process.env.NEXT_PUBLIC_ENV ?? 'local';
  const envClass = ENV_COLOR[env] ?? ENV_COLOR.local;

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const initials = (session?.user.email ?? '??').slice(0, 2).toUpperCase();

  return (
    <>
      <header className="h-14 border-b border-line2 px-6 flex items-center justify-between gap-4 bg-surface/95 backdrop-blur sticky top-0 z-10">
        {/* Left: title + env badge */}
        <div className="flex items-center gap-3 min-w-0">
          {title && (
            <span className="text-sm font-semibold text-ink tracking-tight truncate">{title}</span>
          )}
          <span
            className={`inline-flex items-center text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full border ${envClass}`}
          >
            {env}
          </span>
        </div>

        {/* Center: command palette trigger */}
        <button
          onClick={() => palette.setOpen(true)}
          className="hidden md:flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-line2 bg-paper hover:bg-surface hover:border-line transition min-w-[300px] max-w-[440px]"
        >
          <Search size={14} className="text-soft" />
          <span className="text-[12px] text-muted flex-1 text-left">
            Jump to · search customer · partner id…
          </span>
          <kbd className="inline-flex items-center gap-0.5 text-[10px] text-soft border border-line2 rounded px-1.5 py-0.5 bg-surface font-mono">
            {isMac ? '⌘' : 'Ctrl'}K
          </kbd>
        </button>

        {/* Right: ws + user + sign out */}
        <div className="flex items-center gap-4">
          <WebsocketBadge connected={wsConnected} />
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-ink text-surface text-[11px] font-semibold tracking-tight">
              {initials}
            </span>
            <div className="text-xs leading-tight hidden sm:block">
              <div className="font-medium text-ink truncate max-w-[180px]">
                {session?.user.email}
              </div>
              <div className="text-muted text-[10px] uppercase tracking-wider">
                {session?.user.role}
              </div>
            </div>
          </div>
          <button onClick={logout} className="text-xs text-muted hover:text-ink transition">
            Sign out
          </button>
        </div>
      </header>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
    </>
  );
}
