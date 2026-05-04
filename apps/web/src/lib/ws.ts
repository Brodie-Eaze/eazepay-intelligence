'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { WsEvent } from './types';

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3000';

interface WsState {
  connected: boolean;
  events: WsEvent[];
}

const MAX_EVENTS = 100;

/** Hook: persistent WS connection w/ ticket auth + exp backoff reconnect. */
export function useAnalyticsWebSocket(): WsState {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<WsEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (!aliveRef.current) return;
      try {
        const { ticket } = await api<{ ticket: string }>('/auth/ws/ticket', { method: 'POST', body: '{}' });
        const ws = new WebSocket(`${WS_BASE}/ws/analytics?ticket=${encodeURIComponent(ticket)}`);
        wsRef.current = ws;

        ws.onopen = () => {
          attemptsRef.current = 0;
          setConnected(true);
        };
        ws.onmessage = (m) => {
          try {
            const evt = JSON.parse(m.data as string) as WsEvent;
            setEvents((prev) => [evt, ...prev].slice(0, MAX_EVENTS));
          } catch {
            // ignore
          }
        };
        ws.onclose = () => {
          setConnected(false);
          if (!aliveRef.current) return;
          attemptsRef.current += 1;
          const base = Math.min(30_000, 250 * 2 ** Math.min(attemptsRef.current, 8));
          const jitter = base * 0.2 * (Math.random() - 0.5) * 2;
          timer = setTimeout(() => void connect(), base + jitter);
        };
        ws.onerror = () => ws.close();
      } catch {
        if (!aliveRef.current) return;
        attemptsRef.current += 1;
        const base = Math.min(30_000, 1_000 * 2 ** Math.min(attemptsRef.current, 8));
        timer = setTimeout(() => void connect(), base);
      }
    };

    void connect();

    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  return { connected, events };
}
