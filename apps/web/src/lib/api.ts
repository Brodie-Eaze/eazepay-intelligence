/**
 * API client. Cookies handle auth — fetch with credentials and mirror the
 * CSRF cookie into X-CSRF-Token on every state-changing request.
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3010';

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2]!) : undefined;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const csrf = readCookie('epi_csrf');
  const method = (init.method ?? 'GET').toUpperCase();
  const isMutating = method !== 'GET' && method !== 'HEAD';

  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (isMutating && csrf) headers.set('X-CSRF-Token', csrf);

  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    method,
    credentials: 'include',
    headers,
  });

  if (!res.ok) {
    let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      body = await res.json();
    } catch {
      // ignore parse error; surface a generic message
    }
    throw new ApiError(
      res.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? `Request failed (${res.status})`,
      body.error?.details,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
