import { describe, expect, it, beforeAll } from 'vitest';
import { encryptPII, decryptPII, hashPII, hashesEqual } from '../../src/shared/utils/encryption.js';
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
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

describe('encryption', () => {
  it('round-trips a plaintext', () => {
    const { ciphertext } = encryptPII('hello@example.com');
    expect(decryptPII(ciphertext)).toBe('hello@example.com');
  });

  it('produces stable hashes for the same input', () => {
    const a = hashPII('Brodie@Example.COM ');
    const b = hashPII('brodie@example.com');
    expect(hashesEqual(a, b)).toBe(true);
  });

  it('produces different ciphertexts for the same input (IV randomness)', () => {
    const a = encryptPII('x');
    const b = encryptPII('x');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects truncated envelopes', () => {
    expect(() => decryptPII(Buffer.from([1, 2, 3]))).toThrow();
  });
});
