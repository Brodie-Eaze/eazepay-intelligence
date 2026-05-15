import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import {
  issueStepUpToken,
  __resetStepUpStateForTests,
} from '../../src/shared/middleware/mfa-step-up.middleware.js';
import { __resetEnvForTests } from '../../src/config/env.js';

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-secret-pepper';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.EAZEPAY_APP_WEBHOOK_SECRET = 'f'.repeat(32);
  process.env.HIGHSALE_WEBHOOK_SECRET = 'g'.repeat(32);
  process.env.MFA_STEP_UP_SECRET = 'h'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

describe('issueStepUpToken', () => {
  beforeEach(() => __resetStepUpStateForTests());

  it('returns a structured token with TTL ≤ 300s', () => {
    const { token, expiresAt } = issueStepUpToken('00000000-0000-7000-8000-000000000001');
    const ttlSeconds = Math.round((expiresAt.getTime() - Date.now()) / 1000);
    expect(ttlSeconds).toBeGreaterThan(280);
    expect(ttlSeconds).toBeLessThanOrEqual(300);
    expect(token.split('.').length).toBe(2);
  });

  it('issues distinct jti per call', () => {
    const a = issueStepUpToken('user-a');
    const b = issueStepUpToken('user-a');
    expect(a.token).not.toBe(b.token);
  });
});
