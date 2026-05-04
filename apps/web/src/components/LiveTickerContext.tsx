'use client';

import { createContext, useContext } from 'react';
import type { WsEvent } from '@/lib/types';

interface Ctx {
  events: WsEvent[];
  connected: boolean;
}

export const LiveTickerContext = createContext<Ctx>({ events: [], connected: false });

export function useLiveTicker(): Ctx {
  return useContext(LiveTickerContext);
}
