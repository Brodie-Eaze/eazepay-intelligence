import { createHmac, randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { v7 as uuidv7 } from 'uuid';
import type { Redis } from 'ioredis';
import type { User } from '@prisma/client';

import { getEnv } from '../../config/env.js';
import { errors } from '../../shared/errors/app-error.js';
import { verifyPassword } from '../../shared/utils/password.js';
import { newJti, newRefreshFamilyId, signJwt, verifyJwt } from '../../shared/utils/jwt.js';
import type { IAuthRepository } from './auth.repository.js';
import { AuthRepository } from './auth.repository.js';

export type AuthScope = 'standard' | 'investor';

export interface IssuedTokens {
  access: { token: string; expiresAt: Date };
  refresh: { token: string; expiresAt: Date };
  csrf: string;
  user: User;
  scope: AuthScope;
}

export class AuthService {
  constructor(
    private readonly repo: IAuthRepository,
    private readonly redis: Redis,
  ) {}

  async login(args: { email: string; password: string; mfaCode?: string }): Promise<IssuedTokens> {
    const user = await this.repo.findUserByEmail(args.email);
    if (!user) throw errors.unauthorized('Invalid credentials');

    const ok = await verifyPassword(user.passwordHash, args.password);
    if (!ok) throw errors.unauthorized('Invalid credentials');

    if (user.mfaEnabled) {
      if (!args.mfaCode) throw errors.unauthorized('MFA code required');
      if (!user.mfaSecret) throw errors.internal('MFA configuration missing');
      const valid = authenticator.verify({ token: args.mfaCode, secret: user.mfaSecret });
      if (!valid) throw errors.unauthorized('Invalid MFA code');
    }

    await this.repo.recordLogin(user.id);
    return this.issueSession(user, 'standard', newRefreshFamilyId());
  }

  async refresh(rawRefreshToken: string): Promise<IssuedTokens> {
    const stored = await this.repo.findRefreshTokenByRaw(rawRefreshToken);
    if (!stored) throw errors.unauthorized('Refresh token not found');
    if (stored.revokedAt) {
      // Token reuse → assume theft, revoke entire family.
      await this.repo.revokeFamily(stored.familyId);
      throw errors.unauthorized('Refresh token reused; family revoked');
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw errors.unauthorized('Refresh token expired');
    }
    const user = await this.repo.findUserById(stored.userId);
    if (!user) throw errors.unauthorized('User not found');

    const env = getEnv();
    const newRaw = AuthRepository.newRawRefreshToken();
    const newExpires = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
    await this.repo.rotateRefreshToken({
      oldId: stored.id,
      newRaw,
      userId: user.id,
      familyId: stored.familyId,
      expiresAt: newExpires,
    });
    const access = this.signAccess(user, 'standard');
    return {
      access,
      refresh: { token: newRaw, expiresAt: newExpires },
      csrf: this.newCsrfToken(),
      user,
      scope: 'standard',
    };
  }

  async toggleScope(user: User, requestedScope: AuthScope): Promise<IssuedTokens> {
    // Investor scope is available to ANY authenticated user — it strips data, never adds.
    // For users whose underlying role is INVESTOR, only investor scope is permitted.
    if (user.role === 'INVESTOR' && requestedScope === 'standard') {
      throw errors.forbidden('Investor accounts cannot drop to standard scope');
    }
    const env = getEnv();
    // Scope toggle re-issues a fresh access token under a new family for clean revocation.
    const familyId = newRefreshFamilyId();
    const refreshRaw = AuthRepository.newRawRefreshToken();
    const refreshExpires = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
    await this.repo.createRefreshToken({
      userId: user.id,
      familyId,
      rawToken: refreshRaw,
      expiresAt: refreshExpires,
    });
    const access = this.signAccess(user, requestedScope);
    return {
      access,
      refresh: { token: refreshRaw, expiresAt: refreshExpires },
      csrf: this.newCsrfToken(),
      user,
      scope: requestedScope,
    };
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    const stored = await this.repo.findRefreshTokenByRaw(rawRefreshToken);
    if (stored) await this.repo.revokeFamily(stored.familyId);
  }

  async issueWsTicket(userId: string, scope: AuthScope): Promise<{ ticket: string; expiresInSeconds: number }> {
    const ttlSeconds = 30;
    const ticketId = uuidv7();
    const token = signJwt(
      { sub: userId, role: 'VIEWER', kind: 'ws_ticket', jti: ticketId, scope },
      ttlSeconds,
    );
    // Store with single-use guarantee — worker checks GETDEL on consume.
    await this.redis.setex(`ws:ticket:${ticketId}`, ttlSeconds, JSON.stringify({ userId, scope }));
    return { ticket: token, expiresInSeconds: ttlSeconds };
  }

  async consumeWsTicket(token: string): Promise<{ userId: string; scope: AuthScope } | null> {
    let payload: ReturnType<typeof verifyJwt>;
    try {
      payload = verifyJwt(token, 'ws_ticket');
    } catch {
      return null;
    }
    const raw = await this.redis.getdel(`ws:ticket:${payload.jti}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId: string; scope: AuthScope };
    return parsed;
  }

  // ─── internal ──────────────────────────────────────────────────────────────

  private async issueSession(user: User, scope: AuthScope, familyId: string): Promise<IssuedTokens> {
    const env = getEnv();
    const refreshRaw = AuthRepository.newRawRefreshToken();
    const refreshExpires = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
    await this.repo.createRefreshToken({
      userId: user.id,
      familyId,
      rawToken: refreshRaw,
      expiresAt: refreshExpires,
    });
    const access = this.signAccess(user, scope);
    return {
      access,
      refresh: { token: refreshRaw, expiresAt: refreshExpires },
      csrf: this.newCsrfToken(),
      user,
      scope,
    };
  }

  private signAccess(user: User, scope: AuthScope): { token: string; expiresAt: Date } {
    const env = getEnv();
    const token = signJwt(
      { sub: user.id, role: user.role, kind: 'access', jti: newJti(), scope },
      env.JWT_ACCESS_TTL_SECONDS,
    );
    return { token, expiresAt: new Date(Date.now() + env.JWT_ACCESS_TTL_SECONDS * 1000) };
  }

  private newCsrfToken(): string {
    // Bound to the access secret so server can verify without DB lookup.
    const random = randomBytes(24).toString('base64url');
    const env = getEnv();
    const sig = createHmac('sha256', env.JWT_ACCESS_SECRET).update(random).digest('base64url');
    return `${random}.${sig}`;
  }
}

export function verifyCsrfToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [random, sig] = parts as [string, string];
  const env = getEnv();
  const expected = createHmac('sha256', env.JWT_ACCESS_SECRET).update(random).digest('base64url');
  return sig === expected;
}
