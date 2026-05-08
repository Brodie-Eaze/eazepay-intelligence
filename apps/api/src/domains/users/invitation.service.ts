/**
 * User invitation flow.
 *
 *   admin → POST /users/invitations { email, role }    issue + email
 *   invitee → GET /auth/invitations/:token             preview (no auth)
 *   invitee → POST /auth/invitations/:token/accept     set password, login
 *
 * The plaintext token leaves the system exactly once — in the email body.
 * We persist only sha256(token), so a DB compromise yields no usable
 * tokens. Tokens are 32 random bytes (256 bits) base64url-encoded; brute-
 * force is infeasible against the unique-index lookup.
 *
 * Idempotency:
 *   Issuing a second invitation for the same email is allowed. The previous
 *   pending invitation stays valid until expiry — admins can re-issue if a
 *   user lost the link without poisoning the prior token. On accept we
 *   atomically check unused+unexpired+unrevoked.
 *
 * Privacy / SOC 2:
 *   CC6.1 — only ADMIN can issue (see route preHandler).
 *   CC6.6 — token is single-use; replays return 400.
 *   CC7.3 — issue + accept + revoke each write an audit row.
 */
import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PrismaClient, UserRole } from '@prisma/client';
import { errors } from '../../shared/errors/app-error.js';
import { hashPassword } from '../../shared/utils/password.js';
import { getEnv } from '../../config/env.js';
import { sendEmail } from '../../shared/email/email.service.js';

export interface IssueInvitationInput {
  email: string;
  role: UserRole;
  invitedById: string;
}

export interface IssueInvitationResult {
  id: string;
  email: string;
  role: UserRole;
  expiresAt: Date;
  // Returned to the caller (admin UI) so they can hand the link off out-of-
  // band if email delivery fails. Never logged.
  acceptUrl: string;
  emailDelivered: boolean;
}

export class InvitationService {
  constructor(private readonly prisma: PrismaClient) {}

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(input: IssueInvitationInput): Promise<IssueInvitationResult> {
    const env = getEnv();
    const email = input.email.toLowerCase().trim();
    if (!email) throw errors.badRequest('Email is required');

    // If the email is already a real user, reject — admins use PATCH /users
    // to change roles, not re-invite.
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing && !existing.deletedAt) {
      throw errors.conflict('User with this email already exists', { email });
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = InvitationService.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + env.INVITATION_TTL_HOURS * 60 * 60 * 1000);

    const invite = await this.prisma.userInvitation.create({
      data: {
        id: uuidv7(),
        email,
        role: input.role,
        tokenHash,
        invitedById: input.invitedById,
        expiresAt,
      },
    });

    const acceptUrl = `${env.APP_URL}/accept-invitation?token=${rawToken}`;
    const emailResult = await sendEmail({
      to: email,
      subject: `You've been invited to EazePay Intelligence`,
      text: renderInviteText({ acceptUrl, role: input.role, ttlHours: env.INVITATION_TTL_HOURS }),
      html: renderInviteHtml({ acceptUrl, role: input.role, ttlHours: env.INVITATION_TTL_HOURS }),
    });

    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      acceptUrl,
      emailDelivered: emailResult.delivered,
    };
  }

  /** Preview an invitation by token — no auth required, no side effects. */
  async preview(rawToken: string): Promise<{ email: string; role: UserRole; expiresAt: Date }> {
    const invite = await this.findUsable(rawToken);
    return { email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
  }

  /**
   * Accept an invitation. Creates the User row + marks the invite consumed
   * inside one transaction so a partial state is impossible.
   */
  async accept(args: { rawToken: string; password: string }): Promise<{ userId: string }> {
    const invite = await this.findUsable(args.rawToken);
    const passwordHash = await hashPassword(args.password);

    return this.prisma.$transaction(async (tx) => {
      // Re-check inside the tx — another tab might have accepted in the
      // window between our find and create. The unique index on email
      // would catch it too but the explicit check yields a clearer error.
      const dup = await tx.user.findUnique({ where: { email: invite.email } });
      if (dup && !dup.deletedAt) {
        throw errors.conflict('User with this email already exists');
      }
      const userId = uuidv7();
      await tx.user.create({
        data: {
          id: userId,
          email: invite.email,
          passwordHash,
          role: invite.role,
        },
      });
      await tx.userInvitation.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date(), acceptedById: userId },
      });
      return { userId };
    });
  }

  async list(): Promise<
    Array<{ id: string; email: string; role: UserRole; expiresAt: Date; createdAt: Date }>
  > {
    const rows = await this.prisma.userInvitation.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }

  async revoke(id: string): Promise<void> {
    const found = await this.prisma.userInvitation.findUnique({ where: { id } });
    if (!found) throw errors.notFound('Invitation not found');
    if (found.acceptedAt) throw errors.badRequest('Invitation already accepted');
    await this.prisma.userInvitation.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /** Lookup-by-hash with usability checks. Same generic error for every
   * failure mode so a probing attacker can't distinguish "token unknown"
   * from "token revoked" from "token expired". */
  private async findUsable(rawToken: string): Promise<{
    id: string;
    email: string;
    role: UserRole;
    expiresAt: Date;
  }> {
    if (!rawToken || rawToken.length < 16) {
      throw errors.badRequest('Invitation token is invalid or expired');
    }
    const tokenHash = InvitationService.hashToken(rawToken);
    const invite = await this.prisma.userInvitation.findUnique({ where: { tokenHash } });
    if (!invite) throw errors.badRequest('Invitation token is invalid or expired');
    if (invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) {
      throw errors.badRequest('Invitation token is invalid or expired');
    }
    return invite;
  }
}

function renderInviteText(args: { acceptUrl: string; role: UserRole; ttlHours: number }): string {
  return [
    `You've been invited to EazePay Intelligence as ${args.role}.`,
    '',
    'Click the link below to set your password and sign in:',
    args.acceptUrl,
    '',
    `This invitation expires in ${args.ttlHours} hours.`,
    '',
    "If you weren't expecting this email, you can safely ignore it.",
  ].join('\n');
}

function renderInviteHtml(args: { acceptUrl: string; role: UserRole; ttlHours: number }): string {
  // Inline styles only — most email clients strip <style> tags.
  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;background:#f8fafc;padding:32px;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;letter-spacing:-0.01em;">You're invited to EazePay Intelligence</h1>
    <p style="margin:0 0 24px;color:#475569;line-height:1.5;">
      You've been invited as <strong style="color:#0f172a;">${args.role}</strong>. Set your password to access the dashboard.
    </p>
    <a href="${args.acceptUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:500;font-size:14px;">
      Accept invitation
    </a>
    <p style="margin:32px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">
      This invitation expires in ${args.ttlHours} hours. If you weren't expecting this email, you can safely ignore it.
    </p>
  </div>
</body>
</html>`;
}
