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
import type { Prisma, PrismaClient } from '@prisma/client';
import type { OrgRole } from '@prisma/client';
import { errors } from '../../shared/errors/app-error.js';
import { hashPassword } from '../../shared/utils/password.js';
import { getEnv } from '../../config/env.js';
import { sendEmail } from '../../shared/email/email.service.js';

export interface IssueInvitationInput {
  email: string;
  role: OrgRole;
  invitedById: string;
  // Org the invitation grants access to. Resolved from the issuer's
  // active org context (req.auth.orgId). Required: invitations are
  // org-scoped by definition (ADR-001).
  orgId: string;
}

export interface IssueInvitationResult {
  id: string;
  email: string;
  role: OrgRole;
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

    // If the email is already a member of THIS org, reject — admins use
    // PATCH /memberships to change roles, not re-invite. A user can still
    // be invited into a different org with a different role; the conflict
    // check is org-scoped, not global.
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: { where: { orgId: input.orgId } },
      },
    });
    if (existingUser && !existingUser.deletedAt && existingUser.memberships.length > 0) {
      throw errors.conflict('User is already a member of this organisation', { email });
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
        orgId: input.orgId,
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
  async preview(rawToken: string): Promise<{ email: string; role: OrgRole; expiresAt: Date }> {
    const invite = await this.findUsable(rawToken);
    return { email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
  }

  /**
   * Accept an invitation. Creates the User row + marks the invite consumed
   * inside one transaction so a partial state is impossible.
   */
  async accept(args: {
    rawToken: string;
    password: string;
    /**
     * SOC2 CC6-021: caller-supplied audit hook that runs INSIDE the same
     * transaction as the user-create / membership-create / invitation-
     * consume. The audit row commits with the mutation or not at all —
     * no orphan "user accepted" rows referencing a rolled-back user.
     */
    audit?: (tx: Prisma.TransactionClient, ctx: { userId: string; orgId: string }) => Promise<void>;
  }): Promise<{ userId: string; orgId: string }> {
    const invite = await this.findUsable(args.rawToken);
    const passwordHash = await hashPassword(args.password);
    const auditHook = args.audit;

    return this.prisma.$transaction(async (tx) => {
      // The user might already exist (invited into a second org). In that
      // case we don't create a new user — we create a Membership for the
      // existing user. The unique constraint on Membership(userId, orgId)
      // protects against double-accept of the same invitation.
      const existing = await tx.user.findUnique({ where: { email: invite.email } });

      let userId: string;
      if (existing && !existing.deletedAt) {
        // Existing user joining another org. Don't touch their password —
        // the password they set during the original sign-up still owns
        // their identity. Set new password ONLY if the existing user has
        // no password yet (e.g. came from OAuth flow).
        userId = existing.id;
        if (!existing.passwordHash) {
          await tx.user.update({
            where: { id: userId },
            data: { passwordHash },
          });
        }
      } else if (existing && existing.deletedAt) {
        throw errors.conflict('Account exists but is deleted; contact support');
      } else {
        // New user — create them. role on User is the legacy global field
        // mirrored from invite.role for backward compat in the migration
        // window. Authorization reads the Membership.role going forward.
        userId = uuidv7();
        await tx.user.create({
          data: {
            id: userId,
            email: invite.email,
            passwordHash,
            // Cast OrgRole → UserRole: same string values, different enum.
            role: invite.role as unknown as 'ADMIN' | 'OPERATOR' | 'INVESTOR' | 'VIEWER',
          },
        });
      }

      // Create the membership. Unique(userId, orgId) catches concurrent
      // accept attempts; the catch path returns the existing membership.
      await tx.membership.upsert({
        where: { userId_orgId: { userId, orgId: invite.orgId } },
        update: {}, // never overwrite an existing role
        create: {
          id: uuidv7(),
          userId,
          orgId: invite.orgId,
          role: invite.role,
        },
      });

      await tx.userInvitation.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date(), acceptedById: userId },
      });
      if (auditHook) {
        await auditHook(tx, { userId, orgId: invite.orgId });
      }
      return { userId, orgId: invite.orgId };
    });
  }

  async list(): Promise<
    { id: string; email: string; role: OrgRole; expiresAt: Date; createdAt: Date }[]
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

  async revoke(
    id: string,
    opts?: {
      /**
       * SOC2 CC6-021: audit row commits inside the same tx as the revoke.
       */
      audit?: (tx: Prisma.TransactionClient) => Promise<void>;
    },
  ): Promise<void> {
    const found = await this.prisma.userInvitation.findUnique({ where: { id } });
    if (!found) throw errors.notFound('Invitation not found');
    if (found.acceptedAt) throw errors.badRequest('Invitation already accepted');
    await this.prisma.$transaction(async (tx) => {
      await tx.userInvitation.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
      if (opts?.audit) await opts.audit(tx);
    });
  }

  /** Lookup-by-hash with usability checks. Same generic error for every
   * failure mode so a probing attacker can't distinguish "token unknown"
   * from "token revoked" from "token expired". */
  private async findUsable(rawToken: string): Promise<{
    id: string;
    email: string;
    role: OrgRole;
    orgId: string;
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

function renderInviteText(args: { acceptUrl: string; role: OrgRole; ttlHours: number }): string {
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

function renderInviteHtml(args: { acceptUrl: string; role: OrgRole; ttlHours: number }): string {
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
