import { createHmac, randomBytes } from 'node:crypto';
import type { PrismaClient, RefreshToken, User } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { getEnv } from '../../config/env.js';

export interface IAuthRepository {
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  recordLogin(userId: string): Promise<void>;
  createRefreshToken(args: {
    userId: string;
    familyId: string;
    rawToken: string;
    expiresAt: Date;
  }): Promise<RefreshToken>;
  findRefreshTokenByRaw(raw: string): Promise<RefreshToken | null>;
  rotateRefreshToken(args: {
    oldId: string;
    newRaw: string;
    userId: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<RefreshToken>;
  revokeFamily(familyId: string): Promise<number>;
  revokeAllForUser(userId: string): Promise<number>;
}

export class AuthRepository implements IAuthRepository {
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

  async recordLogin(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  }

  async createRefreshToken(args: {
    userId: string;
    familyId: string;
    rawToken: string;
    expiresAt: Date;
  }): Promise<RefreshToken> {
    return this.prisma.refreshToken.create({
      data: {
        id: uuidv7(),
        userId: args.userId,
        familyId: args.familyId,
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
    oldId: string;
    newRaw: string;
    userId: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<RefreshToken> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          id: uuidv7(),
          userId: args.userId,
          familyId: args.familyId,
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

  async revokeAllForUser(userId: string): Promise<number> {
    const res = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }
}
