import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticator } from 'otplib';
import { v7 as uuidv7 } from 'uuid';
import type { Redis } from 'ioredis';
import type { User } from '@prisma/client';

import { getEnv } from '../../config/env.js';
import { getLogger } from '../../config/logger.js';
import { getPrisma } from '../../config/database.js';
import { errors } from '../../shared/errors/app-error.js';
import { verifyPassword } from '../../shared/utils/password.js';
import { newJti, newRefreshFamilyId, signJwt, verifyJwt } from '../../shared/utils/jwt.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';
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
    private readonly repo: AuthRepository,
    private readonly redis: Redis,
  ) {}

  async login(args: { email: string; password: string; mfaCode?: string }): Promise<IssuedTokens> {
    const user = await this.repo.findUserByEmail(args.email);
    if (!user) throw errors.unauthorized('Invalid credentials');

    // OAuth-only users (no local password) cannot use the password path.
    // Returning the same generic error keeps the response indistinguishable
    // from a wrong password — no email-existence enumeration.
    if (!user.passwordHash) throw errors.unauthorized('Invalid credentials');

    const ok = await verifyPassword(user.passwordHash, args.password);
    if (!ok) throw errors.unauthorized('Invalid credentials');

    if (user.mfaEnabled) {
      if (!args.mfaCode) throw errors.unauthorized('MFA code required');
      if (!user.mfaSecret) throw errors.internal('MFA configuration missing');
      const valid = authenticator.verify({ token: args.mfaCode, secret: user.mfaSecret });
      if (!valid) throw errors.unauthorized('Invalid MFA code');
    }

    await this.repo.recordLogin(user.id);
    const familyId = newRefreshFamilyId();
    // Phase 4c: 1:1 session-to-family for now. Once "trust this device"
    // lands, sessionId persists across family rotations on the same device.
    return this.issueSession(user, 'standard', familyId, familyId);
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
    // Phase 1 retrofit: refresh-token org is preserved across rotation.
    // The stored row already carries orgId from when it was issued; we
    // re-use it for the rotated row so a single refresh chain stays
    // pinned to one tenant rather than drifting to whatever the user's
    // oldest membership happens to be at this moment.
    const refreshOrgId = stored.orgId;
    await this.repo.rotateRefreshToken({
      orgId: refreshOrgId,
      oldId: stored.id,
      newRaw,
      userId: user.id,
      familyId: stored.familyId,
      // Phase 4c: preserve sessionId across rotation so the session
      // identity stays stable for the user-facing /auth/sessions surface.
      sessionId: stored.sessionId,
      expiresAt: newExpires,
    });
    const access = await this.signAccess(user, 'standard', stored.sessionId);
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
    // Phase 4c: scope toggle starts a new session (different family,
    // different session) so revoking the toggled session doesn't kill
    // the user's other devices.
    const sessionId = familyId;
    const refreshRaw = AuthRepository.newRawRefreshToken();
    const refreshExpires = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
    // Phase 1 retrofit: scope toggle inherits orgId from the user's
    // oldest membership (same source as the access JWT). Once an explicit
    // org-switcher endpoint lands, callers pass orgId directly.
    const scopeMembership = await this.repo.findOldestMembership(user.id);
    const scopeOrgId = scopeMembership?.orgId ?? (await getBootstrapOrgId(getPrisma()));
    await this.repo.createRefreshToken({
      orgId: scopeOrgId,
      userId: user.id,
      familyId,
      sessionId,
      rawToken: refreshRaw,
      expiresAt: refreshExpires,
    });
    const access = await this.signAccess(user, requestedScope, sessionId);
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

  /**
   * Phase 4c: enumerate the user's active refresh-token sessions.
   * Surfaces sessionId, the org the session is acting under, and the
   * createdAt / expiresAt of the most recent rotation in that session.
   */
  async listSessions(
    userId: string,
  ): Promise<{ sessionId: string; orgId: string; createdAt: Date; expiresAt: Date }[]> {
    return this.repo.listActiveSessions(userId);
  }

  /**
   * Phase 4c: revoke a single session (all refresh rows sharing that
   * sessionId). Returns the count of refresh rows revoked.
   */
  async revokeSession(userId: string, sessionId: string): Promise<number> {
    return this.repo.revokeSession(userId, sessionId);
  }

  async issueWsTicket(
    userId: string,
    scope: AuthScope,
    orgId: string | null,
  ): Promise<{ ticket: string; expiresInSeconds: number }> {
    const ttlSeconds = 30;
    const ticketId = uuidv7();
    const token = signJwt(
      { sub: userId, role: 'VIEWER', kind: 'ws_ticket', jti: ticketId, scope },
      ttlSeconds,
    );
    // Store with single-use guarantee — worker checks GETDEL on consume.
    // `orgId` is captured here (from the issuing request's auth context) so
    // the WS gateway can filter pub/sub events per-tenant. Platform staff
    // tickets carry `orgId: null` and receive all events.
    await this.redis.setex(
      `ws:ticket:${ticketId}`,
      ttlSeconds,
      JSON.stringify({ userId, scope, orgId }),
    );
    return { ticket: token, expiresInSeconds: ttlSeconds };
  }

  async consumeWsTicket(
    token: string,
  ): Promise<{ userId: string; scope: AuthScope; orgId: string | null } | null> {
    let payload: ReturnType<typeof verifyJwt>;
    try {
      payload = verifyJwt(token, 'ws_ticket');
    } catch {
      return null;
    }
    const raw = await this.redis.getdel(`ws:ticket:${payload.jti}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId: string; scope: AuthScope; orgId?: unknown };
    // CR-8 (2026-05-26): reject malformed orgId rather than coercing to
    // `null` (platform-staff). The previous F-007 fix collapsed empty
    // strings + non-string values to `null`, but the gateway treats
    // `null` as see-all-orgs (STAFF/SUPER). A ticket accidentally minted
    // with `orgId: ""` would therefore PROMOTE the session to
    // platform-staff visibility — exactly backwards. Fail closed by
    // returning `null` from this method, which the gateway treats as a
    // 1008 ticket-invalid close (see analytics.gateway.ts:46).
    //
    // Valid shapes: explicit `null` (platform staff) OR non-empty string.
    if (parsed.orgId !== null && (typeof parsed.orgId !== 'string' || parsed.orgId.length === 0)) {
      getLogger().warn(
        { errorId: 'ws_ticket_invalid_orgid', userId: parsed.userId },
        'rejecting WS ticket with malformed orgId',
      );
      return null;
    }
    const orgId: string | null = parsed.orgId;
    return { userId: parsed.userId, scope: parsed.scope, orgId };
  }

  /**
   * Public issue-session helper for non-password login paths (invitation
   * acceptance, OAuth callback). Goes through the same token machinery as
   * the password login so refresh-token rotation + family revocation behave
   * identically.
   */
  async issueSessionForUser(user: User, scope: AuthScope = 'standard'): Promise<IssuedTokens> {
    await this.repo.recordLogin(user.id);
    const familyId = newRefreshFamilyId();
    return this.issueSession(user, scope, familyId, familyId);
  }

  // ─── internal ──────────────────────────────────────────────────────────────

  private async issueSession(
    user: User,
    scope: AuthScope,
    familyId: string,
    sessionId: string,
  ): Promise<IssuedTokens> {
    const env = getEnv();
    const refreshRaw = AuthRepository.newRawRefreshToken();
    const refreshExpires = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
    // Phase 1 retrofit: pin the refresh token to the user's active org
    // (oldest membership during the Phase 1.3 transition; an explicit
    // org-switcher endpoint will replace this once it lands).
    const sessionMembership = await this.repo.findOldestMembership(user.id);
    const sessionOrgId = sessionMembership?.orgId ?? (await getBootstrapOrgId(getPrisma()));
    await this.repo.createRefreshToken({
      orgId: sessionOrgId,
      userId: user.id,
      familyId,
      sessionId,
      rawToken: refreshRaw,
      expiresAt: refreshExpires,
    });
    const access = await this.signAccess(user, scope, sessionId);
    return {
      access,
      refresh: { token: refreshRaw, expiresAt: refreshExpires },
      csrf: this.newCsrfToken(),
      user,
      scope,
    };
  }

  private async signAccess(
    user: User,
    scope: AuthScope,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const env = getEnv();
    // Phase 1.3: embed the user's active organisation + per-org role in the
    // access token. Resolution: oldest Membership (first org joined) wins
    // during the migration window; an explicit org-switcher endpoint
    // (Phase 1.3 expansion) lets the user change active org later.
    // Platform staff are embedded so requireAuth can short-circuit
    // platform-route checks without an extra DB hit.
    // Phase 4c: embed `sid` (sessionId) so the access JWT can be denied
    // immediately when the refresh-token session is revoked.
    const membership = await this.repo.findOldestMembership(user.id);
    const token = signJwt(
      {
        sub: user.id,
        role: user.role,
        org: membership?.orgId,
        orgRole: membership?.role,
        platformRole: user.platformRole ?? null,
        kind: 'access',
        jti: newJti(),
        sid: sessionId,
        scope,
      },
      env.JWT_ACCESS_TTL_SECONDS,
    );
    return { token, expiresAt: new Date(Date.now() + env.JWT_ACCESS_TTL_SECONDS * 1000) };
  }

  private newCsrfToken(): string {
    // P0 fix (SEC-115): CSRF token HMAC uses CSRF_SIGNING_SECRET, not the
    // JWT access secret. Sharing the JWT key meant any compromise of the
    // access secret (e.g., offline brute-force on a captured cookie)
    // immediately compromised CSRF protection too. Fallback to
    // JWT_ACCESS_SECRET during the migration window so existing CSRF
    // cookies remain valid until rotation; production startup enforces
    // CSRF_SIGNING_SECRET to be set.
    const random = randomBytes(24).toString('base64url');
    const env = getEnv();
    const sig = createHmac('sha256', env.CSRF_SIGNING_SECRET ?? env.JWT_ACCESS_SECRET)
      .update(random)
      .digest('base64url');
    return `${random}.${sig}`;
  }
}

export function verifyCsrfToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [random, sig] = parts as [string, string];
  const env = getEnv();
  // Match the secret used in `newCsrfToken` — CSRF_SIGNING_SECRET if set,
  // JWT_ACCESS_SECRET otherwise. Once production rotates, the fallback path
  // is unreachable because env.ts requires CSRF_SIGNING_SECRET to be set.
  const csrfSecret = env.CSRF_SIGNING_SECRET ?? env.JWT_ACCESS_SECRET;
  const expected = createHmac('sha256', csrfSecret).update(random).digest('base64url');
  // Constant-time compare. A naive `sig === expected` short-circuits on the
  // first byte mismatch and would leak the signature byte-by-byte under a
  // chatty attacker. Use timingSafeEqual with a length-equality pre-check.
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}
