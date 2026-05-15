import argon2 from 'argon2';
import { getLogger } from '../../config/logger.js';

/** argon2id with sane defaults — OWASP-recommended (m=64MB, t=3, p=4). */
const OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch (err) {
    // SF-005: argon2.verify throws on malformed hashes, unsupported algorithm
    // versions, native binding load failures, or memory-exhaustion. The
    // bare catch turned all of those into a generic "wrong password",
    // hiding two important failure modes:
    //   (1) a corrupted hash row leaves the user permanently locked out
    //       and operators chase a credentials bug
    //   (2) if the argon2 native binding fails to load (deployment bug),
    //       EVERY login fails as "wrong password"
    // Log the underlying cause so SIEM correlates the spike; still return
    // false (don't distinguish "wrong password" vs "verify threw" to the
    // caller — that's the audit log's job).
    getLogger().error({ err, errorId: 'pwd_verify_threw' }, 'password.verify_failed');
    return false;
  }
}
