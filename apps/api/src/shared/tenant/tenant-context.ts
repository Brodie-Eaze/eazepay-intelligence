/**
 * Tenant context — request-scoped store + Prisma session helper.
 *
 * Two surfaces:
 *
 *   1. AsyncLocalStorage<TenantContext>: a process-wide store keyed by the
 *      currently-running async chain. Used by the Prisma `$extends` middleware
 *      (Phase 1.3 expansion) to inject `where: { orgId }` automatically and
 *      by the Postgres GUC helper to pin RLS scoping.
 *
 *   2. withTenantSession(prisma, ctx, fn): wraps a function in a Prisma
 *      transaction with `SET LOCAL app.org_id = '<uuid>'` (and optional
 *      platform-staff bypass). Inside `fn`, every Prisma query against this
 *      tx-bound client respects the RLS policies created in Phase 1.4.
 *
 * USAGE PATTERN (post Phase 1.3 wiring):
 *
 *   // In a Fastify route (after requireAuthAndTenant runs):
 *   const result = await withTenantSession(prisma, {
 *     orgId: req.auth.orgId!,
 *     platformStaff: req.auth.platformRole != null,
 *   }, async (tx) => {
 *     // Every tx.* call here has app.org_id set; RLS enforces it.
 *     return tx.partner.findMany(...);
 *   });
 *
 * PLATFORM-STAFF BYPASS:
 *   When `platformStaff = true`, sets `app.platform_staff = 'true'` so the
 *   policies' OR clause kicks in. Cross-tenant reads are then permitted —
 *   but the application layer must still write a `PLATFORM_CROSS_TENANT_ACCESS`
 *   audit row (see platform.routes.ts).
 *
 * SPECIAL ESCAPES (used by `requireAuthAndTenant`-bypass routes):
 *   - withInvitationLookup(prisma, fn)        — public /auth/invitations/:token
 *   - withBearerLookup(prisma, fn)            — bearer-auth PAT resolve
 *   - withWebhookSignatureLookup(prisma, fn)  — inbound webhook sig verify
 *
 * Each escape sets a single, scoped GUC that satisfies a specific RLS policy
 * and nothing else. Don't use these for general queries — they're surgical
 * carve-outs for pre-tenant-context lookups.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient } from '@prisma/client';

export interface TenantContext {
  /** UUID of the active organization. */
  orgId: string;
  /**
   * When true, sets `app.platform_staff = 'true'` in the Postgres session.
   * Bypasses tenant filtering for legitimate cross-tenant operations.
   * Caller is responsible for writing a PLATFORM_CROSS_TENANT_ACCESS audit row.
   */
  platformStaff?: boolean;
}

/**
 * Process-wide async-local store for the active tenant context.
 *
 * Populated by `withTenantSession` and `runWithTenantContext`. Read by the
 * Prisma `$extends` middleware (Phase 1.3 expansion). Outside an explicit
 * `run` scope, `getTenantContext()` returns undefined — code paths that
 * need tenant context must either receive it explicitly or run inside a
 * `withTenantSession` block.
 */
const tenantStore = new AsyncLocalStorage<TenantContext>();

/** Read the current tenant context. Returns undefined outside a run scope. */
export function getTenantContext(): TenantContext | undefined {
  return tenantStore.getStore();
}

/**
 * Run `fn` with `ctx` available via getTenantContext() for the duration
 * of the async chain. Does NOT touch Postgres — this is purely the
 * AsyncLocalStorage layer. Use `withTenantSession` when you also need
 * RLS enforcement at the DB level.
 */
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run(ctx, fn);
}

type TenantTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Run `fn` inside a Prisma transaction with the Postgres GUCs needed for RLS
 * to enforce tenant isolation. The provided `tx` client is the only Prisma
 * handle that should be used inside `fn` — using the outer client bypasses
 * the GUC and (in production with eazepay_app role) returns zero rows.
 *
 * Tradeoffs to be aware of:
 *   - Every tenant-scoped request opens its own transaction. Postgres can
 *     handle this; long-running requests still complete cheaply.
 *   - SET LOCAL is scoped to the transaction, so connection pool reuse is safe.
 *   - The orgId is parameterized via `$executeRaw` template literal to prevent
 *     injection — Prisma rejects non-Prisma.sql values in raw queries.
 */
export async function withTenantSession<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Cast: PrismaClient and TransactionClient share method shape; the type
    // system protects us from $-prefixed lifecycle methods inadvertently.
    const txClient = tx as unknown as TenantTx;
    await tx.$executeRaw`SELECT set_config('app.org_id', ${ctx.orgId}, true)`;
    if (ctx.platformStaff) {
      await tx.$executeRaw`SELECT set_config('app.platform_staff', 'true', true)`;
    }
    return runWithTenantContext(ctx, () => fn(txClient));
  });
}

/**
 * Surgical escape for the public invitation-accept flow.
 * Allows a single SELECT on user_invitations matched by token_hash, before
 * any tenant context is established. The plaintext token is unguessable
 * (32 random bytes), so this lookup is effectively gated by token possession.
 */
export async function withInvitationLookup<T>(
  prisma: PrismaClient,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const txClient = tx as unknown as TenantTx;
    await tx.$executeRaw`SELECT set_config('app.invitation_lookup', 'true', true)`;
    return fn(txClient);
  });
}

/**
 * Surgical escape for the bearer-auth middleware. Permits the lookup of a
 * PAT by `hashed_secret` so the middleware can establish the org context;
 * subsequent queries in the same request use `withTenantSession` instead.
 */
export async function withBearerLookup<T>(
  prisma: PrismaClient,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const txClient = tx as unknown as TenantTx;
    await tx.$executeRaw`SELECT set_config('app.bearer_lookup', 'true', true)`;
    return fn(txClient);
  });
}

/**
 * Surgical escape for inbound webhook signature verification. Allows the
 * verifyWebhookSignature middleware to look up `webhook_credentials` by
 * `(source, signing_secret_hash)` before the org context exists. The
 * subsequent webhook event is processed under `withTenantSession` once
 * the credential's org_id is resolved.
 */
export async function withWebhookSignatureLookup<T>(
  prisma: PrismaClient,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const txClient = tx as unknown as TenantTx;
    await tx.$executeRaw`SELECT set_config('app.webhook_signature_lookup', 'true', true)`;
    return fn(txClient);
  });
}

/**
 * Used by the Phase 1.3 Prisma `$extends` middleware to detect whether the
 * caller has opted into tenant scoping. Returns the same value every async
 * chain that's been wrapped by `withTenantSession` or `runWithTenantContext`.
 */
export function requireTenantContext(): TenantContext {
  const ctx = getTenantContext();
  if (!ctx) {
    throw new Error(
      'requireTenantContext: no tenant context in scope. Wrap the call in withTenantSession or runWithTenantContext.',
    );
  }
  return ctx;
}

// Re-export the Prisma type so callers don't need a separate import.
export type { Prisma };
