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

export function ingestionRateLimit(): { rateLimit: RateLimitConfig } {
  return {
    rateLimit: {
      max: getEnv().RATE_LIMIT_INGESTION_PER_MIN,
      timeWindow: '1 minute',
    },
  };
}

export function webhookRateLimit(): { rateLimit: RateLimitConfig } {
  return {
    rateLimit: {
      max: getEnv().RATE_LIMIT_WEBHOOK_PER_MIN,
      timeWindow: '1 minute',
    },
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
