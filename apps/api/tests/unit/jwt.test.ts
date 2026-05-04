import { describe, expect, it, beforeAll } from 'vitest';
import { signJwt, verifyJwt, newJti } from '../../src/shared/utils/jwt.js';
import { __resetEnvForTests } from '../../src/config/env.js';

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'pepper';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.BUZZPAY_WEBHOOK_SECRET = 'c'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

describe('jwt', () => {
  it('signs and verifies an access token', () => {
    const tok = signJwt({ sub: 'u1', role: 'OPERATOR', kind: 'access', jti: newJti() }, 60);
    const payload = verifyJwt(tok, 'access');
    expect(payload.sub).toBe('u1');
    expect(payload.kind).toBe('access');
  });

  it('rejects token signed with refresh secret as access', () => {
    const tok = signJwt({ sub: 'u1', role: 'OPERATOR', kind: 'refresh', jti: newJti(), fid: 'fam' }, 60);
    expect(() => verifyJwt(tok, 'access')).toThrow();
  });

  it('rejects expired tokens', async () => {
    const tok = signJwt({ sub: 'u1', role: 'OPERATOR', kind: 'access', jti: newJti() }, -1);
    expect(() => verifyJwt(tok, 'access')).toThrow();
  });

  it('rejects tampered tokens', () => {
    const tok = signJwt({ sub: 'u1', role: 'OPERATOR', kind: 'access', jti: newJti() }, 60);
    const tampered = `${tok.slice(0, -2)}xx`;
    expect(() => verifyJwt(tampered, 'access')).toThrow();
  });
});
