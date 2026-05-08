-- User invitations + OAuth federated identity.
--
-- 1. password_hash becomes nullable: OAuth-only users have no local password.
-- 2. google_sub: stable Google subject id (sub claim). Unique partial index
--    so SELECT...WHERE google_sub = ? is fast and we can't double-claim.
-- 3. user_invitations: admin-issued invites; only the SHA-256 of the token
--    is stored, not the plaintext.

ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "google_sub" TEXT;
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

CREATE TABLE "user_invitations" (
  "id"               UUID         PRIMARY KEY,
  "email"            TEXT         NOT NULL,
  "role"             "UserRole"   NOT NULL,
  "token_hash"       TEXT         NOT NULL,
  "invited_by_id"    UUID         NOT NULL,
  "expires_at"       TIMESTAMPTZ(6) NOT NULL,
  "accepted_at"      TIMESTAMPTZ(6),
  "accepted_by_id"   UUID,
  "revoked_at"       TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_invitations_invited_by_id_fkey"
    FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_invitations_token_hash_key" ON "user_invitations"("token_hash");
CREATE INDEX "user_invitations_email_idx" ON "user_invitations"("email");
CREATE INDEX "user_invitations_expires_at_idx" ON "user_invitations"("expires_at");
