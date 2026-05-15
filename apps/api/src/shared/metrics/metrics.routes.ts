/**
 * GET /metrics — Prometheus scrape endpoint.
 *
 * Returns the in-process registry's Prometheus v0.0.4 text exposition.
 * Unauthenticated by design — scrapers are inside the trust boundary
 * (Railway internal networking / a sidecar). For public-internet exposure,
 * proxy this behind a basic-auth header in the deployment config.
 *
 * SOC 2 (CC4.1 / CC7.2): metrics ARE the operational monitoring surface.
 * The endpoint must be available even when the API is degraded; we
 * intentionally don't wrap it in tenant context, RLS, or rate-limit.
 */
import type { FastifyInstance } from 'fastify';
import { renderMetrics } from './metrics.js';

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', { config: { skipCsrf: true } }, async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return renderMetrics();
  });
}
