import type { UserRole, OrgRole, PlatformRole } from '@prisma/client';
import type { AuthScope } from './auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface AuthContext {
  userId: string;
  email: string;
  /**
   * Legacy global role. Authorization decisions migrate to `orgRole`
   * during Phase 1.3 (tenant middleware). Still populated from the JWT
   * for backward compat in the migration window.
   */
  role: UserRole;
  /**
   * Active organisation. Populated by the tenant-resolution middleware
   * (Phase 1.3) from the URL path `:orgSlug` parameter, intersected
   * with the user's Membership rows. Optional on the type because the
   * JWT can be valid without an active org (e.g., an org-switcher
   * landing page that has not yet selected an org). Routes that
   * require tenant scope assert `req.auth.orgId` is set.
   */
  orgId?: string;
  /**
   * Per-org role for the active org, derived from the Membership row
   * matched by `orgId`. Phase 1.3 populates this from the JWT claim
   * (embedded at login, ~15-min staleness window). Same four levels
   * as legacy UserRole, intentionally.
   */
  orgRole?: OrgRole;
  /**
   * Platform-level capability that crosses orgs. null = ordinary user.
   * SUPER bypasses org membership checks; STAFF reads cross-org but
   * cannot write outside their own memberships.
   */
  platformRole?: PlatformRole | null;
  scope: AuthScope;
  jti: string;
  /**
   * Phase 4c: refresh-token session id this access token was issued
   * under. Allows /auth/sessions to mark the current session distinctly
   * (so the UI doesn't accidentally let the user revoke the very session
   * they're using). Optional during the migration window — pre-Phase-4c
   * tokens still verify but carry no sid.
   */
  sid?: string;
}
