import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env.js';
import { errors } from '../errors/app-error.js';

/**
 * Minimal HS256 JWT — no third-party dep needed.
 * Two distinct secrets: ACCESS for short-lived API tokens, REFRESH for rotation.
 */

export type JwtKind = 'access' | 'refresh' | 'investor_scope' | 'ws_ticket';

export interface JwtPayload {
  sub: string; // user id
  /** Legacy global role. Preserved during the migration window. */
  role: 'ADMIN' | 'OPERATOR' | 'INVESTOR' | 'VIEWER';
  /**
   * Active organisation. Embedded at login from the user's first (oldest)
   * Membership during the Phase 1.3 transition; later replaced by an
   * explicit org-switcher endpoint. Optional for backward compat with
   * tokens minted before this field was added — those tokens still verify.
   */
  org?: string;
  /**
   * Per-org role for the active org. Same four levels as `role`,
   * scoped to the active organisation. Optional during migration window.
   */
  orgRole?: 'ADMIN' | 'OPERATOR' | 'INVESTOR' | 'VIEWER';
  /**
   * Platform-level capability — STAFF reads cross-org, SUPER writes
   * cross-org. Embedded so the auth middleware doesn't need a DB hit
   * just to confirm platform privileges. Mutations to platform_role
   * take up to JWT_ACCESS_TTL_SECONDS to propagate; if hostile-revocation
   * becomes a requirement, add a Redis deny-list keyed on (sub, jti).
   */
  platformRole?: 'STAFF' | 'SUPER' | null;
  scope?: 'standard' | 'investor';
  kind: JwtKind;
  fid?: string; // refresh token family id
  jti: string; // unique token id
  iat: number;
  exp: number;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function secretFor(kind: JwtKind): string {
  const env = getEnv();
  return kind === 'refresh' ? env.JWT_REFRESH_SECRET : env.JWT_ACCESS_SECRET;
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, ttlSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const body = b64url(JSON.stringify(full));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', secretFor(payload.kind)).update(data).digest());
  return `${data}.${sig}`;
}

export function verifyJwt(token: string, expectedKind: JwtKind): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw errors.unauthorized('Malformed token');
  const [header, body, sig] = parts as [string, string, string];
  const data = `${header}.${body}`;
  const expected = createHmac('sha256', secretFor(expectedKind)).update(data).digest();
  const provided = fromB64url(sig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw errors.unauthorized('Invalid token signature');
  }
  let payload: JwtPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8')) as JwtPayload;
  } catch {
    throw errors.unauthorized('Token payload not parseable');
  }
  if (payload.kind !== expectedKind) {
    throw errors.unauthorized('Token kind mismatch');
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw errors.unauthorized('Token expired');
  }
  return payload;
}

export function newJti(): string {
  return randomBytes(16).toString('base64url');
}

export function newRefreshFamilyId(): string {
  return randomBytes(16).toString('hex');
}
