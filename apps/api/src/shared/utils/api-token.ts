/**
 * API token shape:  epi_pk_<8-byte prefix>_<24-byte secret>
 *                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *                   visible identifier              | secret half (sha256 hashed at rest)
 *
 * On creation we return the full token ONCE. Server stores only:
 *   - prefix (visible, indexed, used to look up the row)
 *   - hashed secret (sha256 hex)
 *
 * On verify we split, look up by prefix, sha256 the secret half and timing-safe compare.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const FULL_PREFIX = 'epi_pk_';
const PREFIX_BYTES = 8;
const SECRET_BYTES = 24;

export interface ParsedToken {
  prefix: string;
  secretHash: string;
}

export function generateApiToken(): { token: string; prefix: string; hashedSecret: string } {
  const prefix = FULL_PREFIX + randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  const token = `${prefix}_${secret}`;
  const hashedSecret = createHash('sha256').update(secret).digest('hex');
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
  const secretHash = createHash('sha256').update(secret).digest('hex');
  return { prefix, secretHash };
}

export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
