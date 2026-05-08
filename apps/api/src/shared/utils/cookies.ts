import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnv } from '../../config/env.js';

/**
 * Cookie names. Single source of truth for the auth surface.
 * - access:  short-lived JWT, httpOnly, used by API
 * - refresh: long-lived rotation token, httpOnly, never readable by JS
 * - csrf:    double-submit token, NOT httpOnly so the SPA can mirror it in X-CSRF-Token
 */
export const COOKIE = {
  ACCESS: 'epi_access',
  REFRESH: 'epi_refresh',
  CSRF: 'epi_csrf',
} as const;

interface SetCookieOpts {
  maxAgeSeconds: number;
  httpOnly: boolean;
  // Default Strict. OAuth state cookies need Lax so the cookie survives the
  // top-level redirect back from accounts.google.com.
  sameSite?: 'strict' | 'lax' | 'none';
}

function baseCookieAttrs(opts: SetCookieOpts): string {
  const env = getEnv();
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  const httpOnly = opts.httpOnly ? '; HttpOnly' : '';
  const ss = opts.sameSite ?? 'strict';
  const sameSite = ss.charAt(0).toUpperCase() + ss.slice(1);
  return `; Path=/; Max-Age=${opts.maxAgeSeconds}${httpOnly}${secure}; SameSite=${sameSite}`;
}

export function setCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  opts: SetCookieOpts,
): void {
  const existing = reply.getHeader('Set-Cookie');
  const cookie = `${name}=${encodeURIComponent(value)}${baseCookieAttrs(opts)}`;
  if (Array.isArray(existing)) {
    reply.header('Set-Cookie', [...existing, cookie]);
  } else if (typeof existing === 'string') {
    reply.header('Set-Cookie', [existing, cookie]);
  } else {
    reply.header('Set-Cookie', cookie);
  }
}

export function clearCookie(reply: FastifyReply, name: string): void {
  setCookie(reply, name, '', { maxAgeSeconds: 0, httpOnly: name !== COOKIE.CSRF });
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const parts = header.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
