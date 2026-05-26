import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { getRedis } from '../../config/redis.js';
import { getLogger } from '../../config/logger.js';
import { errors } from '../errors/app-error.js';

/**
 * Composite-key rate limit. Used for `/auth/login` (bucket on ip + email) and
 * `/auth/mfa/verify` + `/auth/mfa/disable` (bucket on userId so brute-force
 * on a 6-digit TOTP code can't ride the global per-user budget).
 *
 * P0 fix (SF-003): fail-CLOSED by default; fail-OPEN ONLY when
 * RATE_LIMIT_FAIL_OPEN=1 (incident bypass). Default posture is fail-closed
 * because the composite rate limit IS the brute-force gate on /auth/login
 * and /auth/mfa/verify — a brief 503 during a Redis outage beats an
 * unbounded brute-force window. The env-gated bypass exists so on-call can
 * unblock auth during a sustained Redis incident without a code deploy.
 *
 * Fail-closed paths (default; flip to 200-allow when RATE_LIMIT_FAIL_OPEN=1):
 *   1. `pipe.exec()` throws (connection-level failure) → 503
 *   2. `pipe.exec()` returns null (MULTI rolled back) → 503
 *   3. A single command result missing from the array → 503
 *   4. Any command returned an error → 503
 *
 * Logged at warn level with a stable `errorId` so the outage surfaces in
 * monitoring rather than disappearing.
 */
export function compositeRateLimit(args: {
  prefix: string;
  windowSeconds: number;
  max: number;
  keys: (req: FastifyRequest) => string[];
}): preHandlerHookHandler {
  return async (req) => {
    // 2026-05-24 incident: default fail-CLOSED restored. RATE_LIMIT_FAIL_OPEN=1
    // is the documented incident bypass — set on Railway only during a
    // sustained Redis outage, otherwise leave unset so brute-force on
    // /auth/login and /auth/mfa/verify remains gated. The global
    // @fastify/rate-limit plugin is an independent throttle and is not
    // affected by this flag.
    const failOpen = process.env.RATE_LIMIT_FAIL_OPEN === '1';
    const redis = getRedis();
    const buckets = args.keys(req).map((k) => `rl:${args.prefix}:${k}`);
    const pipe = redis.multi();
    for (const b of buckets) {
      pipe.incr(b);
      pipe.expire(b, args.windowSeconds, 'NX');
    }

    let results: Awaited<ReturnType<typeof pipe.exec>>;
    try {
      results = await pipe.exec();
    } catch (err) {
      getLogger().warn(
        { err, errorId: 'rate_limit_redis_down', prefix: args.prefix, failOpen },
        failOpen
          ? 'rate-limit pipe rejected — failing OPEN per RATE_LIMIT_FAIL_OPEN=1'
          : 'rate-limit pipe rejected — failing closed',
      );
      if (failOpen) return;
      throw errors.serviceUnavailable('Rate-limit infrastructure unavailable');
    }
    if (!results) {
      getLogger().warn(
        { errorId: 'rate_limit_multi_rollback', prefix: args.prefix, failOpen },
        failOpen
          ? 'rate-limit MULTI null — failing OPEN per RATE_LIMIT_FAIL_OPEN=1'
          : 'rate-limit MULTI returned null — failing closed',
      );
      if (failOpen) return;
      throw errors.serviceUnavailable('Rate-limit infrastructure unavailable');
    }

    for (let i = 0; i < buckets.length; i += 1) {
      const incrResult = results[i * 2];
      if (!incrResult) {
        getLogger().warn(
          { errorId: 'rate_limit_pipe_corrupt', prefix: args.prefix, bucketIndex: i, failOpen },
          'rate-limit incr missing from pipe result',
        );
        if (failOpen) return;
        throw errors.serviceUnavailable('Rate-limit infrastructure unavailable');
      }
      const [err, count] = incrResult;
      if (err) {
        getLogger().warn(
          { err, errorId: 'rate_limit_incr_failed', prefix: args.prefix, bucketIndex: i, failOpen },
          'rate-limit incr errored',
        );
        if (failOpen) return;
        throw errors.serviceUnavailable('Rate-limit infrastructure unavailable');
      }
      if (typeof count === 'number' && count > args.max) {
        throw errors.rateLimited(args.windowSeconds);
      }
    }
  };
}
