/** @type {import('next').NextConfig} */
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
  async rewrites() {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3010';
    return [{ source: '/proxy/api/:path*', destination: `${apiBase}/api/v1/:path*` }];
  },
};

export default nextConfig;
