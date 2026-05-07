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
  // Optional read replica. Analytics + dashboard reads route here when set.
  // Falls back to primary if the replica is unreachable at boot.
  DATABASE_REPLICA_URL: z.string().url().optional(),
  // Optional long-running worker URL. When set, workers (export, aggregation,
  // scheduled-report) connect as `eazepay_worker_long` with a 5-min
  // statement_timeout instead of the API's 30-sec budget. Falls back to
  // DATABASE_URL when unset.
  DATABASE_LONG_URL: z.string().url().optional(),
  // Slow-query threshold for Prisma query logging (CC7.2 monitoring).
  DATABASE_SLOW_QUERY_LOG_MS: z.coerce.number().int().positive().default(500),
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
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // Tiered rate limits — see docs/COMPUTE_LIMITS.md for sizing rationale.
  // Anonymous: tight; protects /auth/login + public endpoints.
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(100),
  // Authenticated session/PAT: per-user (not per-IP) so devs behind a NAT
  // aren't punished. Falls back to IP if no auth context.
  RATE_LIMIT_PER_USER_PER_MIN: z.coerce.number().int().positive().default(1000),
  // Ingestion endpoints (PAT-driven ETL). Sized for 1k-row/min sustained.
  RATE_LIMIT_INGESTION_PER_MIN: z.coerce.number().int().positive().default(6_000),
  // Vendor webhook ingress per source IP. Sized for vendor retry storms.
  RATE_LIMIT_WEBHOOK_PER_MIN: z.coerce.number().int().positive().default(10_000),

  // Per-route body limits (bytes). UI requests stay tiny; bulk/webhook bigger.
  BODY_LIMIT_DEFAULT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1 * 1024 * 1024),
  BODY_LIMIT_BULK_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  BODY_LIMIT_WEBHOOK_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),

  // Worker concurrency (BullMQ). Bound CPU + DB connections per process.
  WORKER_WEBHOOK_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WORKER_OUTBOX_BATCH: z.coerce.number().int().positive().default(100),
  WORKER_DELIVERY_CONCURRENCY: z.coerce.number().int().positive().default(20),

  // Multi-currency. DEFAULT_CURRENCY is what we tag a RevenueEvent with
  // when the inbound webhook payload doesn't specify a currency (legacy
  // BuzzPay payloads). REPORTING_CURRENCY is the rollup currency for
  // analytics — every cross-portfolio aggregation converts into this via
  // FxService. Both are ISO-4217 alpha-3.
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
  REPORTING_CURRENCY: z.string().length(3).default('USD'),

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
