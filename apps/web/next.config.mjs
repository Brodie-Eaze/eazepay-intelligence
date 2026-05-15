/** @type {import('next').NextConfig} */

/**
 * P0 fix (SEC-131) — security headers.
 *
 * Previously this file had `poweredByHeader: false` and nothing else. The
 * web tier is what owns the auth cookies; a single React-side XSS would
 * drain HttpOnly cookies via a token-stealing redirect with no CSP to
 * stop it.
 *
 * - HSTS: 1-year max-age with includeSubDomains + preload.
 * - CSP: `self` for scripts; `'unsafe-inline'` for styles only (Next's
 *   static optimisation injects inline critical CSS without a nonce hook).
 *   Inline scripts blocked entirely. `connect-src` covers the API origin
 *   plus its WebSocket equivalent. `frame-ancestors 'none'` matches the
 *   API CSP.
 * - Referrer-Policy: strict-origin-when-cross-origin.
 * - Permissions-Policy: deny every feature the dashboard doesn't use.
 * - X-Content-Type-Options nosniff + X-Frame-Options DENY + COOP same-origin.
 */
function buildCsp() {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3010';
  let apiHttp = apiBase;
  let apiWs = apiBase.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:'));
  try {
    const u = new URL(apiBase);
    apiHttp = `${u.protocol}//${u.host}`;
    apiWs = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  } catch {
    /* fall through to defaults */
  }
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    // Next's static optimisation injects inline critical CSS without a
    // nonce hook. unsafe-inline scoped to styles only is the standard
    // mitigation; it does not weaken script protection.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", apiHttp, apiWs],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  { key: 'Content-Security-Policy', value: buildCsp() },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'accelerometer=(), camera=(), display-capture=(), document-domain=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Standalone output bundles a minimal server.js + tracing-determined
  // node_modules into .next/standalone. Required for the Docker runner
  // image to stay small without copying the full monorepo.
  output: 'standalone',
  // typedRoutes off — we drive nav from a config table where Route literals
  // can't be statically inferred. Re-enable when the navigation table is
  // generated rather than hand-authored.
  experimental: { typedRoutes: false },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3010';
    return [{ source: '/proxy/api/:path*', destination: `${apiBase}/api/v1/:path*` }];
  },
};

export default nextConfig;
