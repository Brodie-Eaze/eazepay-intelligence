/**
 * API token shape:  epi_pk_<8-byte prefix>_<24-byte secret>
 *                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *                   visible identifier              | secret half (HMAC-hashed at rest)
 *
 * On creation we return the full token ONCE. Server stores only:
 *   - prefix (visible, indexed, used to look up the row)
 *   - hashed secret (HMAC-SHA-256 with API_TOKEN_HASH_SECRET pepper, hex)
 *
 * On verify we split, look up by prefix, HMAC the secret half and timing-safe compare.
 *
 * P0 fix (CR-103): previous implementation used bare SHA-256 — no key, no
 * salt, no pepper. If the `api_tokens` table is exfiltrated, an attacker
 * runs offline brute-force against the 192-bit secret entropy. SHA-256 is
 * a one-way function but not a keyed MAC; rainbow tables for fixed-length
 * hex inputs are GPU-feasible. HMAC-SHA-256 with a server-side pepper
 * (API_TOKEN_HASH_SECRET) defeats offline cracking because the attacker
 * also needs the application secret.
 *
 * Backward-compat: when API_TOKEN_HASH_SECRET is unset (dev or
 * pre-rotation prod), we fall back to bare SHA-256 so existing tokens
 * keep verifying. The fallback path becomes unreachable in production
 * once env.ts enforces the secret. Long-term, add a `hashVersion` column
 * to api_tokens and dual-verify during a 90-day rotation window.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env.js';

const FULL_PREFIX = 'epi_pk_';
const PREFIX_BYTES = 8;
const SECRET_BYTES = 24;

export interface ParsedToken {
  prefix: string;
  secretHash: string;
}

/**
 * Hash a token secret under the production-grade keyed scheme
 * (HMAC-SHA-256 with API_TOKEN_HASH_SECRET) if available, else the
 * legacy bare SHA-256. Both branches return hex.
 */
function hashSecret(secret: string): string {
  const pepper = getEnv().API_TOKEN_HASH_SECRET;
  if (pepper) {
    return createHmac('sha256', pepper).update(secret).digest('hex');
  }
  // Legacy path — pre-rotation dev environments. Production startup
  // enforces API_TOKEN_HASH_SECRET to be set, so prod never reaches here.
  return createHash('sha256').update(secret).digest('hex');
}

export function generateApiToken(): { token: string; prefix: string; hashedSecret: string } {
  const prefix = FULL_PREFIX + randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  const token = `${prefix}_${secret}`;
  const hashedSecret = hashSecret(secret);
  return { token, prefix, hashedSecret };
}

export function parseApiToken(token: string): ParsedToken | null {
  // Format: epi_pk_<16hex>_<48hex>
  if (!token.startsWith(FULL_PREFIX)) return null;
  const parts = token.split('_');
  if (parts.length !== 4) return null;
  const prefix = `${parts[0]}_${parts[1]}_${parts[2]}`;
  const secret = parts[3];
  if (!secret || prefix.length !== FULL_PREFIX.length + PREFIX_BYTES * 2) return null;
  const secretHash = hashSecret(secret);
  return { prefix, secretHash };
}

export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
