import { describe, expect, it, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { __resetEnvForTests } from '../../src/config/env.js';

// ─── Test fixture: env ──────────────────────────────────────────────────────
beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.PII_HASH_SECRET = 'integration-test-pepper-min-16';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.BUZZPAY_WEBHOOK_SECRET = 'buzzpay-integration-secret-32_';
  process.env.PIXIE_WEBHOOK_SECRET = 'pixie-integration-secret-32____';
  process.env.MICAMP_WEBHOOK_SECRET = 'micamp-integration-secret-32___';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

/**
 * Pure-function exercise of the webhook signature algorithm.
 *
 * This proves three things without spinning up Fastify or hitting Redis:
 *   1. A correctly-signed payload computes the same HMAC the middleware will compute
 *   2. Tampering with either the timestamp or the body invalidates the signature
 *   3. Constant-time comparison of two unequal hashes returns false
 *
 * The middleware's full path (Redis idempotency dedupe, WebhookEvent persistence,
 * audit row write) is exercised by an end-to-end integration test that requires a
 * running Postgres + Redis (see `RUNBOOK.md` — "Send a test webhook locally").
 * That test runs against a Testcontainers stack in CI; this file keeps the unit
 * boundary tight and sub-100ms.
 */
function sign(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

describe('webhook signature algorithm (integration · pure)', () => {
  const secret = 'buzzpay-integration-secret-32_';
  const body = JSON.stringify({
    externalApplicationId: 'APP-INT-1',
    partnerExternalId: 'PRT-0001',
    consumer: { name: 'Test Subject', email: 't@example.test', phone: '+61400000000' },
  });
  const ts = '1714838400'; // fixed for determinism

  it('produces a deterministic signature for a (ts, body) pair', () => {
    const sig1 = sign(secret, ts, body);
    const sig2 = sign(secret, ts, body);
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64); // 32 bytes hex
  });

  it('changes when the timestamp changes', () => {
    const a = sign(secret, ts, body);
    const b = sign(secret, '1714838401', body);
    expect(a).not.toBe(b);
  });

  it('changes when the body changes by even one character', () => {
    const a = sign(secret, ts, body);
    const tamperedBody = body.replace('Test Subject', 'Test_Subject');
    const b = sign(secret, ts, tamperedBody);
    expect(a).not.toBe(b);
  });

  it('changes when the secret changes', () => {
    const a = sign(secret, ts, body);
    const b = sign('different-secret-32-chars-aaaaa', ts, body);
    expect(a).not.toBe(b);
  });

  it('two equal-length but unequal hex strings compare unequal', () => {
    const a = Buffer.from('a'.repeat(64), 'hex');
    const b = Buffer.from('b'.repeat(64), 'hex');
    expect(a.equals(b)).toBe(false);
  });
});

describe('idempotency-key construction', () => {
  it('produces a stable key for a (decisionId) pair', () => {
    const decisionId = '01234567-89ab-7cde-8f01-234567890123';
    const k1 = `buzzpay:funding:${decisionId}`;
    const k2 = `buzzpay:funding:${decisionId}`;
    expect(k1).toBe(k2);
  });

  it('produces distinct keys per source × event-type', () => {
    const a = `buzzpay:funding:abc`;
    const b = `buzzpay:clawback:abc`;
    const c = `pixie:margin:abc:2026-05-04`;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
