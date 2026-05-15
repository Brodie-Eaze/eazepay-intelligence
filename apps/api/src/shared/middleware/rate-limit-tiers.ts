/**
 * Per-route rate-limit tiers.
 *
 * The global rate limit (set in server.ts) is the floor for dashboard /
 * authenticated traffic at RATE_LIMIT_PER_USER_PER_MIN. Routes with higher
 * throughput characteristics (ingestion, webhooks) opt up via the per-route
 * `config.rateLimit` knob exposed by @fastify/rate-limit.
 *
 * Why per-tier instead of one big number? Two reasons:
 *   1. A dashboard user shouldn't share a bucket with a backfill ETL — an
 *      ETL spike at midnight should not 429 a human at 9 a.m.
 *   2. Vendor webhooks have their own retry storms (BuzzPay's exponential
 *      backoff can replay 5 times in 60s; multiply by event volume). The
 *      webhook tier accommodates this without giving everyone else the same.
 *
 * SOC 2 mapping:
 *   - CC6.1 — gates compute consumption per principal
 *   - A1.1  — capacity headroom budgeted per workload class
 */
import { getEnv } from '../../config/env.js';

export interface RateLimitConfig {
  max: number;
  timeWindow: string;
}

/**
 * Route config tag (`req.routeOptions.config.skipCsrf`) used by the CSRF
 * middleware to opt a route out of CSRF verification. Set on every webhook
 * and integration endpoint that authenticates via HMAC signature instead of
 * session cookies. The CSRF middleware reads this from the resolved
 * routeOptions (set at registration time) — it cannot be poisoned by
 * request input. See CR-101 / SEC-107 for the URL-prefix bypass this
 * replaces.
 */
export const SKIP_CSRF = { skipCsrf: true } as const;

/**
 * Ingestion routes accept both cookie (operator dashboard) and Bearer-PAT
 * (programmatic ETL) auth via requireCookieOrBearer. CSRF applies only to
 * cookie callers; the csrfGuard middleware detects the Authorization header
 * directly and exempts bearer callers without needing a route-level opt-out.
 * So no `skipCsrf` here — cookie callers must still present a CSRF token.
 */
export function ingestionRateLimit(): { rateLimit: RateLimitConfig } {
  return {
    rateLimit: {
      max: getEnv().RATE_LIMIT_INGESTION_PER_MIN,
      timeWindow: '1 minute',
    },
  };
}

export function webhookRateLimit(): { rateLimit: RateLimitConfig; skipCsrf: true } {
  return {
    rateLimit: {
      max: getEnv().RATE_LIMIT_WEBHOOK_PER_MIN,
      timeWindow: '1 minute',
    },
    skipCsrf: true,
  };
}

/** Strict bucket for unauthenticated / sensitive surfaces (auth, password reset). */
export function strictRateLimit(): { rateLimit: RateLimitConfig } {
  return {
    rateLimit: {
      max: getEnv().RATE_LIMIT_PER_IP_PER_MIN,
      timeWindow: '1 minute',
    },
  };
}
