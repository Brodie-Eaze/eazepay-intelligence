import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { getRedis } from '../../config/redis.js';
import { errors } from '../errors/app-error.js';

/**
 * Composite-key rate limit. Used for `/auth/login` where we need to bucket on
 * (ip, email) so attackers can't spray a million emails from one IP and can't
 * try a million passwords for one email from a botnet.
 */
export function compositeRateLimit(args: {
  prefix: string;
  windowSeconds: number;
  max: number;
  keys: (req: FastifyRequest) => string[];
}): preHandlerHookHandler {
  return async (req) => {
    const redis = getRedis();
    const buckets = args.keys(req).map((k) => `rl:${args.prefix}:${k}`);
    const pipe = redis.multi();
    for (const b of buckets) {
      pipe.incr(b);
      pipe.expire(b, args.windowSeconds, 'NX');
    }
    const results = await pipe.exec();
    if (!results) return;

    for (let i = 0; i < buckets.length; i += 1) {
      const incrResult = results[i * 2];
      if (!incrResult) continue;
      const [err, count] = incrResult;
      if (err) continue;
      if (typeof count === 'number' && count > args.max) {
        throw errors.rateLimited(args.windowSeconds);
      }
    }
  };
}
