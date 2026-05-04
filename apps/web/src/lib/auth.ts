'use client';

import { createContext, useContext } from 'react';
import type { SessionResponse, UserResponse } from './types';

export interface AuthContextValue {
  session: SessionResponse | null;
  setSession: (s: SessionResponse | null) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth used outside AuthProvider');
  return ctx;
}

export function useUser(): UserResponse | null {
  const { session } = useAuth();
  return session?.user ?? null;
}

export function useScope(): 'standard' | 'investor' | null {
  return useUser()?.scope ?? null;
}
