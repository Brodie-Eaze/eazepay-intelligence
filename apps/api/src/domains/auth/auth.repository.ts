import { createHmac, randomBytes } from 'node:crypto';
import type { OrgRole, PrismaClient, RefreshToken, User } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { getEnv } from '../../config/env.js';

export interface MembershipRef {
  orgId: string;
  role: OrgRole;
}

export class AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Hash a refresh token for at-rest storage.
   *
   * HMAC-SHA-256 keyed with `JWT_REFRESH_SECRET`, not bare SHA-256. The raw
   * token is 48 random bytes, so SHA-256 alone would already be cryptographically
   * sound (no length-extension exposure on a fixed-length input), but HMAC:
   *
   *   - removes the theoretical length-extension class entirely
   *   - couples the index to the deployment's secret (an attacker with
   *     read-only DB access cannot pre-compute hashes from raw tokens
   *     without also obtaining the env)
   *   - costs nothing — same primitive, one extra parameter
   *
   * Standard pattern at financial platforms; cheap correctness win.
   */
  static hashRefresh(raw: string): string {
    return createHmac('sha256', getEnv().JWT_REFRESH_SECRET).update(raw).digest('hex');
  }

  static newRawRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

  async findUserById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  async findOldestMembership(userId: string): Promise<MembershipRef | null> {
    const m = await this.prisma.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { orgId: true, role: true },
    });
    return m;
  }

  async recordLogin(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  }

  async createRefreshToken(args: {
    /**
     * Phase 1 retrofit: refresh tokens are now org-scoped. orgId is sourced
     * from the active membership at session-issue time; multi-org users get
     * one refresh family per org rather than one shared across orgs (which
     * was the prior latent bug — a stolen refresh from one org would have
     * worked across all of the user's orgs).
     */
    orgId: string;
    userId: string;
    familyId: string;
    /**
     * Phase 4c: persistent session identifier. Today defaults to familyId
     * (1:1); future "trust this device" work may let multiple families
     * share a sessionId. Embedded in the access JWT as `sid` so a revoked
     * session immediately denies outstanding access tokens.
     */
    sessionId: string;
    rawToken: string;
    expiresAt: Date;
  }): Promise<RefreshToken> {
    return this.prisma.refreshToken.create({
      data: {
        id: uuidv7(),
        orgId: args.orgId,
        userId: args.userId,
        familyId: args.familyId,
        sessionId: args.sessionId,
        tokenHash: AuthRepository.hashRefresh(args.rawToken),
        expiresAt: args.expiresAt,
      },
    });
  }

  async findRefreshTokenByRaw(raw: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash: AuthRepository.hashRefresh(raw) },
    });
  }

  async rotateRefreshToken(args: {
    orgId: string;
    oldId: string;
    newRaw: string;
    userId: string;
    familyId: string;
    sessionId: string;
    expiresAt: Date;
  }): Promise<RefreshToken> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          id: uuidv7(),
          orgId: args.orgId,
          userId: args.userId,
          familyId: args.familyId,
          sessionId: args.sessionId,
          tokenHash: AuthRepository.hashRefresh(args.newRaw),
          expiresAt: args.expiresAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: args.oldId },
        data: { revokedAt: new Date(), replacedBy: created.id },
      });
      return created;
    });
  }

  async revokeFamily(familyId: string): Promise<number> {
    const res = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }

  /**
   * Phase 4c: revoke every refresh in a session. Today === revokeFamily,
   * but using the sessionId surface keeps the user-facing API (one
   * session = one revocation unit) independent of the rotation chain.
   */
  async revokeSession(userId: string, sessionId: string): Promise<number> {
    const res = await this.prisma.refreshToken.updateMany({
      where: { userId, sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const res = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }

  /**
   * Phase 4c: enumerate the user's active sessions. One row per
   * sessionId. Each session's `lastUsedAt` is the createdAt of the most
   * recent (rotated) refresh row in that session. `revokedAt IS NULL`
   * means at least one row in the session is still live.
   */
  async listActiveSessions(
    userId: string,
  ): Promise<{ sessionId: string; orgId: string; createdAt: Date; expiresAt: Date }[]> {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { sessionId: true, orgId: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    // Collapse to one row per sessionId. Keep the most-recent rotation.
    const bySession = new Map<
      string,
      { sessionId: string; orgId: string; createdAt: Date; expiresAt: Date }
    >();
    for (const r of rows) {
      if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, r);
    }
    return [...bySession.values()];
  }
}
