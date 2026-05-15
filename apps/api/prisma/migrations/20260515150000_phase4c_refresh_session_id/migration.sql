-- Phase 4c — refresh-token session_id binding.
--
-- Today, a refresh-token row has (orgId, userId, familyId). One "session"
-- = one familyId; rotations preserve the familyId. familyId is opaque to
-- the user; there is no surface that lists "your active sessions" or lets
-- a user revoke one device without nuking the whole family.
--
-- This migration adds a session_id column. Going forward:
--
--   - issueSession() generates a fresh session_id (=== familyId during
--     the transition window — we keep them 1:1 so existing revocation
--     by familyId continues to work).
--   - rotateRefreshToken() preserves session_id alongside familyId.
--   - the access JWT carries `sid` so requireAuth can deny it when the
--     session is revoked (Redis deny-list, mirrors the existing jti
--     deny-list from Phase 4a).
--   - /auth/sessions enumerates the user's active sessions (one row per
--     (userId, sessionId) with `revokedAt IS NULL`).
--   - /auth/sessions/:id DELETE revokes a single session (= a single
--     familyId today; future multi-family-per-session work goes here).
--
-- Why a column rather than re-using familyId everywhere:
--   - familyId is a token-rotation concept (theft detection — if a
--     revoked refresh is presented again, the entire family is poisoned).
--   - session_id is a user-facing concept (one device, one IP, one
--     login). They happen to be 1:1 today but will diverge if we ever
--     allow "remember this device" (rotate-but-don't-revoke-on-replay).
--   - Adding the column now means the migration is cheap and the
--     conceptual separation is in the schema before we need it.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS session_id uuid;

-- Backfill session_id := family_id for existing rows. Idempotent.
UPDATE refresh_tokens
  SET session_id = family_id
  WHERE session_id IS NULL;

-- Make it NOT NULL going forward.
ALTER TABLE refresh_tokens
  ALTER COLUMN session_id SET NOT NULL;

-- Helpful index for /auth/sessions enumeration (user + active sessions).
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_session_id_revoked_at_idx
  ON refresh_tokens (user_id, session_id, revoked_at);
