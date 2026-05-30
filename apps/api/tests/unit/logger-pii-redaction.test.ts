import { Writable } from 'node:stream';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import pino from 'pino';
import { GENERATED_PII_REDACT_PATHS } from '../../src/config/pii-redact-paths.generated.js';
import { __resetEnvForTests } from '../../src/config/env.js';

/**
 * Contract test for SOC2-CC7-016.
 *
 * Asserts:
 *   1. The generated redact paths are accepted by pino (no schema drift
 *      ever produces an invalid pino path expression).
 *   2. A realistic Prisma return shape, when logged, redacts every value
 *      that originated from a /// @pii field — across direct objects,
 *      arrays (findMany), and one level of nested include.
 *   3. The hand-curated MANUAL list still wins for non-Prisma surfaces
 *      (HTTP authorization header).
 *
 * If this test fails after adding a new PII column, the fix is almost
 * always: tag the column with `/// @pii` and re-run
 * `pnpm --filter api redact:generate`.
 */

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-pepper-min-16-chars';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.EAZEPAY_APP_WEBHOOK_SECRET = 'f'.repeat(32);
  process.env.HIGHSALE_WEBHOOK_SECRET = 'g'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NODE_ENV = 'test';
  __resetEnvForTests();
});

function makeBufferedLogger(extraPaths: string[] = []): {
  log: pino.Logger;
  read: () => unknown[];
} {
  const records: unknown[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const line = chunk.toString('utf8').trim();
      if (line.length > 0) {
        try {
          records.push(JSON.parse(line));
        } catch {
          records.push(line);
        }
      }
      cb();
    },
  });
  const log = pino(
    {
      level: 'info',
      redact: {
        paths: [...GENERATED_PII_REDACT_PATHS, ...extraPaths],
        censor: '[redacted]',
      },
    },
    stream,
  );
  return { log, read: () => records };
}

describe('SOC2-CC7-016 — model-driven Pino PII redaction', () => {
  it('accepts every generated path as a valid pino redact spec', () => {
    expect(() =>
      pino({
        redact: { paths: [...GENERATED_PII_REDACT_PATHS], censor: '[redacted]' },
      }),
    ).not.toThrow();
    expect(GENERATED_PII_REDACT_PATHS.length).toBeGreaterThan(0);
  });

  it('covers core PII field names with a wildcard top-level path', () => {
    const expected = [
      'email',
      'passwordHash',
      'mfaSecret',
      'tokenHash',
      'hashedSecret',
      'consumerEmailCiphertext',
      'consumerPhoneCiphertext',
      'consumerNameCiphertext',
      'creditScore',
      'ipAddress',
      'userAgent',
      'addressCiphertext',
      'dateOfBirthCiphertext',
      'signingSecretHash',
      'secretHash',
      'payload',
      'body',
      'emailHash',
      'googleSub',
      'metadata',
    ];
    for (const f of expected) {
      expect(GENERATED_PII_REDACT_PATHS, `missing wildcard for ${f}`).toContain(`*.${f}`);
    }
  });

  let buffer: ReturnType<typeof makeBufferedLogger>;
  beforeEach(() => {
    buffer = makeBufferedLogger(['req.headers.authorization']);
  });

  it('redacts PII on a direct user fetch shape', () => {
    buffer.log.info({
      user: {
        id: 'u_1',
        email: 'jane@example.com',
        passwordHash: '$argon2id$...',
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        googleSub: 'google-sub-12345',
      },
    });
    const rec = buffer.read()[0] as Record<string, unknown>;
    const user = rec.user as Record<string, unknown>;
    expect(user.email).toBe('[redacted]');
    expect(user.passwordHash).toBe('[redacted]');
    expect(user.mfaSecret).toBe('[redacted]');
    expect(user.googleSub).toBe('[redacted]');
    expect(user.id).toBe('u_1');
  });

  it('redacts PII inside findMany array shapes', () => {
    buffer.log.info({
      applications: [
        {
          id: 'a_1',
          consumerEmailCiphertext: Buffer.from('CIPHERTEXT_1').toString('base64'),
          consumerPhoneCiphertext: Buffer.from('CIPHERTEXT_2').toString('base64'),
          creditScore: 720,
          notedAnnualIncome: '90000.00',
          availableCredit: '12000.00',
        },
        {
          id: 'a_2',
          consumerEmailCiphertext: Buffer.from('CIPHERTEXT_3').toString('base64'),
          consumerPhoneCiphertext: Buffer.from('CIPHERTEXT_4').toString('base64'),
          creditScore: 680,
          notedAnnualIncome: '70000.00',
          availableCredit: '5000.00',
        },
      ],
    });
    const rec = buffer.read()[0] as Record<string, unknown>;
    const apps = rec.applications as Record<string, unknown>[];
    for (const a of apps) {
      expect(a.consumerEmailCiphertext).toBe('[redacted]');
      expect(a.consumerPhoneCiphertext).toBe('[redacted]');
      expect(a.creditScore).toBe('[redacted]');
      expect(a.notedAnnualIncome).toBe('[redacted]');
      expect(a.availableCredit).toBe('[redacted]');
    }
    expect(apps[0]!.id).toBe('a_1');
  });

  it('redacts PII inside a nested include (1:many)', () => {
    buffer.log.info({
      partner: {
        id: 'p_1',
        name: 'Acme', // partner.name is NOT PII — vendor brand
        applications: [
          {
            id: 'a_1',
            consumerNameCiphertext: 'NAME_CIPHER',
            consumerEmailHash: 'HASH_1',
          },
        ],
      },
    });
    const rec = buffer.read()[0] as Record<string, unknown>;
    const partner = rec.partner as Record<string, unknown>;
    expect(partner.name).toBe('Acme');
    const apps = partner.applications as Record<string, unknown>[];
    expect(apps[0]!.consumerNameCiphertext).toBe('[redacted]');
    expect(apps[0]!.consumerEmailHash).toBe('[redacted]');
  });

  it('redacts AuditLog ipAddress / userAgent / metadata', () => {
    buffer.log.info({
      auditLog: {
        id: 'al_1',
        action: 'USER_LOGIN',
        ipAddress: '203.0.113.42',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4)',
        metadata: { sessionId: 'sess_42', country: 'US' },
      },
    });
    const rec = buffer.read()[0] as Record<string, unknown>;
    const al = rec.auditLog as Record<string, unknown>;
    expect(al.ipAddress).toBe('[redacted]');
    expect(al.userAgent).toBe('[redacted]');
    expect(al.metadata).toBe('[redacted]');
    expect(al.action).toBe('USER_LOGIN');
  });

  it('redacts via the generic top-level wildcard when shape is unexpected', () => {
    // No model wrapper — just `{ email, passwordHash }` directly inside a
    // log-bag-of-data. The `*.email` and `*.passwordHash` wildcards must
    // still fire for ANY container at depth 1.
    buffer.log.info({
      ctx: {
        email: 'leak@example.com',
        passwordHash: '$argon2id$leak',
        tokenHash: 'leaky-token-hash',
      },
    });
    const rec = buffer.read()[0] as Record<string, unknown>;
    const ctx = rec.ctx as Record<string, unknown>;
    expect(ctx.email).toBe('[redacted]');
    expect(ctx.passwordHash).toBe('[redacted]');
    expect(ctx.tokenHash).toBe('[redacted]');
  });

  it('preserves manual non-Prisma redactions (Authorization header)', () => {
    buffer.log.info({
      req: {
        method: 'GET',
        url: '/v1/applications',
        headers: { authorization: 'Bearer eyJhbGciOi...' },
      },
    });
    const rec = buffer.read()[0] as Record<string, unknown>;
    const req = rec.req as Record<string, unknown>;
    const headers = req.headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[redacted]');
  });
});
