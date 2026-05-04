import { pino, type Logger } from 'pino';
import { getEnv } from './env.js';

/**
 * Structured Pino logger. Production: JSON to stdout. Development: pretty.
 * PII redaction is enforced at the logger level — NEVER log raw PII fields.
 */
let cached: Logger | undefined;

const PII_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  '*.consumerName',
  '*.consumerEmail',
  '*.consumerPhone',
  '*.passwordHash',
  '*.password',
  '*.mfaSecret',
  '*.tokenHash',
  '*.refreshToken',
  '*.accessToken',
  '*.PII_ENCRYPTION_KEY',
  '*.PII_HASH_SECRET',
];

export function getLogger(): Logger {
  if (cached) return cached;
  const env = getEnv();
  const baseOpts = {
    level: env.LOG_LEVEL,
    redact: { paths: PII_REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'eazepay-intelligence-api', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  };
  cached = env.NODE_ENV === 'development'
    ? pino({
        ...baseOpts,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
        },
      })
    : pino(baseOpts);
  return cached;
}

export function __resetLoggerForTests(): void {
  cached = undefined;
}
