import { z } from 'zod';

/**
 * Single source of truth for environment configuration.
 * Validated at boot — invalid env aborts the process before any side effects.
 * `.env.example` is hand-mirrored from this schema; CI must verify they match.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be ≥32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be ≥32 chars'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),

  PII_ENCRYPTION_KEY: z
    .string()
    .min(1, 'PII_ENCRYPTION_KEY required (base64-encoded 32 bytes)')
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'PII_ENCRYPTION_KEY must decode to exactly 32 bytes',
    }),
  PII_HASH_SECRET: z.string().min(16, 'PII_HASH_SECRET must be ≥16 chars'),

  BUZZPAY_WEBHOOK_SECRET: z.string().min(16),
  PIXIE_WEBHOOK_SECRET: z.string().min(16),
  MICAMP_WEBHOOK_SECRET: z.string().min(16),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3001')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_PER_USER_PER_MIN: z.coerce.number().int().positive().default(1000),

  PIXIE_VOLUME_BREAKPOINT: z.coerce.number().int().nonnegative().default(25_000),
  PIXIE_COST_PER_PULL: z.coerce.number().nonnegative().default(1),
  PIXIE_CHARGE_PER_PULL: z.coerce.number().nonnegative().default(3),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Cannot use the logger here — env failure occurs before logger is built.
    // eslint-disable-next-line no-console
    console.error('[env] invalid configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only reset hook. Never call from production code. */
export function __resetEnvForTests(): void {
  cached = undefined;
}
