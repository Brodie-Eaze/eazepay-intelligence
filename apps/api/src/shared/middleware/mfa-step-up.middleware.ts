/**
 * MFA step-up gate (Phase H — hardening to ≥90).
 *
 * Critical SUPER actions (cryptoshred, impersonation-token issue, DLQ
 * replay, quarantine replay, tenant offboarding) require a fresh MFA
 * proof — not just an active session. The session already proves the
 * user authenticated some time ago; step-up proves the *current request*
 * was authorised by the human at the keyboard, not by a stolen cookie.
 *
 * Flow:
 *   1. User calls POST /auth/mfa/step-up/start (issues nothing — just
 *      tells the dashboard to prompt for a TOTP).
 *   2. User submits POST /auth/mfa/step-up/verify with their TOTP.
 *      Server validates against mfaSecret, signs a short-lived
 *      step-up token, returns it as `__Host-mfa_stepup` cookie + JSON.
 *   3. Dashboard re-submits the gated action with the cookie attached.
 *   4. `requireMfaStepUp()` middleware verifies the cookie HMAC, checks
 *      iat is within `STEP_UP_TTL_SECONDS` (300s default), checks sub
 *      matches req.auth.userId. Fails closed otherwise.
 *
 * Why a separate signed-token instead of "MFA verified this session":
 *   - The session is 15-min access + long refresh. Re-proving MFA every
 *     15 min for routine actions is hostile UX; pinning it to "the last
 *     5 minutes for SUPER actions only" is the right tradeoff.
 *   - The cookie is HMAC-signed with STEP_UP_SECRET (own purpose-specific
 *     secret per Phase 0 CR-102). Reuse against a different user is
 *     blocked by the `sub` claim.
 *   - Replays inside the 5-minute window are bounded by an in-memory
 *     once-per-jti set, just like the access-token deny-list.
 *
 * If a user without MFA enabled hits a gated route → 403 with
 * `error: 'MFA_NOT_ENABLED'`. They must enable MFA to use SUPER actions.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { errors } from '../errors/app-error.js';
import { getEnv } from '../../config/env.js';
import { readCookie } from '../utils/cookies.js';

const STEP_UP_COOKIE = '__Host-mfa_stepup';
const STEP_UP_TTL_SECONDS = 300; // 5 minutes
// In-process replay-detection store — same single-use guarantee as ws_ticket.
// Process-local is acceptable here because step-up tokens are short-lived
// and a balanced load-balancer routes the same user to the same pod most
// of the time. A determined attacker re-using a token across pods within
// 5 minutes is theoretically possible but caught by the cookie's bound
// `sub` claim — the attacker needs to be the same user.
//
// Phase H reviewer fix (arch-critic #3): the previous implementation
// `consumedJtis.clear()` on bloat would have opened a small replay window
// — a token consumed at t=0 with `iat=t` could be replayed at t=29s if
// the set was cleared at t=30s, because the 300s freshness check still
// passed. Now we store {jti → exp} and prune only entries that have
// already expired (the iat freshness check would reject them anyway), so
// shrinking the store can never re-enable a still-valid jti.
const consumedJtis = new Map<string, number /* exp unix seconds */>();
const PRUNE_THRESHOLD = 10_000;

function stepUpSecret(): string {
  const env = getEnv();
  // SEC-203/secret-discipline: no JWT_ACCESS_SECRET fallback. Production
  // refuses to boot if MFA_STEP_UP_SECRET is unset.
  if (!env.MFA_STEP_UP_SECRET) {
    throw new Error('mfa-step-up: MFA_STEP_UP_SECRET is required');
  }
  return env.MFA_STEP_UP_SECRET;
}

interface StepUpPayload {
  sub: string; // userId
  jti: string;
  iat: number; // unix seconds
}

/**
 * Issue a step-up token for the given userId. Called from /auth/mfa/step-up/verify
 * AFTER the TOTP has been validated.
 */
export function issueStepUpToken(userId: string): {
  token: string;
  expiresAt: Date;
} {
  const iat = Math.floor(Date.now() / 1000);
  const jti = randomBytes(16).toString('base64url');
  const payload: StepUpPayload = { sub: userId, iat, jti };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', stepUpSecret()).update(body).digest('base64url');
  return {
    token: `${body}.${sig}`,
    expiresAt: new Date((iat + STEP_UP_TTL_SECONDS) * 1000),
  };
}

function parse(token: string): StepUpPayload | null {
  const [body, sig] = token.split('.') as [string, string];
  if (!body || !sig) return null;
  const expected = createHmac('sha256', stepUpSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StepUpPayload;
  } catch {
    return null;
  }
}

/**
 * Preflight gate for SUPER actions. Reads the __Host-mfa_stepup cookie,
 * verifies HMAC, checks iat freshness, checks sub matches req.auth.userId,
 * marks jti consumed. Fails closed in every error path.
 */
export const requireMfaStepUp: preHandlerHookHandler = async (
  req: FastifyRequest,
  _reply: FastifyReply,
) => {
  if (!req.auth) throw errors.unauthorized('Step-up requires prior auth');
  const cookie = readCookie(req, STEP_UP_COOKIE);
  // Phase H frontend rounding: use the dedicated MFA_STEP_UP_REQUIRED
  // error code on every failure path so the dashboard intercepts them
  // uniformly + prompts for TOTP without parsing a free-text message.
  if (!cookie) throw errors.mfaStepUpRequired();
  const payload = parse(cookie);
  if (!payload) throw errors.mfaStepUpRequired('Invalid step-up token');
  if (payload.sub !== req.auth.userId)
    throw errors.mfaStepUpRequired('Step-up token user mismatch');
  const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
  if (ageSeconds < 0 || ageSeconds > STEP_UP_TTL_SECONDS) {
    throw errors.mfaStepUpRequired('Step-up token expired');
  }
  if (consumedJtis.has(payload.jti)) {
    throw errors.mfaStepUpRequired('Step-up token already used');
  }
  // Consume on success — single-use until the token's natural exp.
  const exp = payload.iat + STEP_UP_TTL_SECONDS;
  consumedJtis.set(payload.jti, exp);
  // Prune lazily once we hit the threshold. Only drop entries past their
  // exp — the freshness check would already reject re-use of those, so
  // shrinking the store can never re-enable a still-valid jti.
  if (consumedJtis.size > PRUNE_THRESHOLD) {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [jti, jtiExp] of consumedJtis) {
      if (jtiExp <= nowSec) consumedJtis.delete(jti);
    }
  }
};

export const STEP_UP_COOKIE_NAME = STEP_UP_COOKIE;
export const STEP_UP_TTL = STEP_UP_TTL_SECONDS;

export function __resetStepUpStateForTests(): void {
  consumedJtis.clear();
}

export function __consumedJtiCountForTests(): number {
  return consumedJtis.size;
}
