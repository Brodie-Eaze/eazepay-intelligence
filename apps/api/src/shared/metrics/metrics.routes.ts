/**
 * GET /metrics — Prometheus scrape endpoint.
 *
 * Returns the in-process registry's Prometheus v0.0.4 text exposition.
 *
 * **Authentication (Phase H reviewer fix):** Railway's HTTPS endpoints
 * are public-Internet reachable. The metric labels (lender slugs, orgs,
 * error ids, traffic shapes) are an attacker recon goldmine if exposed
 * unauthenticated. The route requires:
 *
 *   - Production (NODE_ENV=production): METRICS_BEARER_TOKEN env var set
 *     + every scrape carries `Authorization: Bearer <token>`. Mismatch →
 *     401 with empty body.
 *   - Dev/test: optional. If `METRICS_BEARER_TOKEN` is unset, /metrics
 *     responds without auth — keeps Prometheus + local Grafana easy.
 *
 * The comparison is constant-time so timing analysis can't recover the
 * token byte-by-byte.
 *
 * SOC 2 (CC4.1 / CC7.2): metrics are the operational monitoring surface;
 * the endpoint must be reachable to scrapers, never to anonymous clients.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getEnv } from '../../config/env.js';
import { prismaPoolMetricsText } from '../../domains/health.routes.js';
import { renderMetrics } from './metrics.js';

function authMetrics(req: FastifyRequest, reply: FastifyReply): boolean {
  const env = getEnv();
  const expected = env.METRICS_BEARER_TOKEN;
  if (!expected) {
    // Dev / no-token mode: only allowed when NODE_ENV !== production.
    // env.ts production-required gate ensures this branch can't fire in prod.
    return true;
  }
  const header = req.headers.authorization;
  const provided =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!provided) {
    reply.code(401).header('WWW-Authenticate', 'Bearer realm="metrics"').send();
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    reply.code(401).send();
    return false;
  }
  return true;
}

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', { config: { skipCsrf: true } }, async (req, reply) => {
    if (!authMetrics(req, reply)) return reply;
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    // Phase H (SEC-305 fix): single /metrics emits BOTH the in-process
    // domain registry AND the Prisma pool metrics (previously a duplicate
    // route in health.routes.ts). Order: app metrics first, then pool
    // metrics. Both already carry HELP/TYPE headers per series.
    const pool = await prismaPoolMetricsText();
    return renderMetrics() + pool;
  });
}
