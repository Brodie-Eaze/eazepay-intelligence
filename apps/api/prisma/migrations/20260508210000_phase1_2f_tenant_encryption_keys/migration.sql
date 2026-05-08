-- Phase 1.2f — tenant_encryption_keys table
--
-- Per-Organisation wrapped Data Encryption Keys for the envelope encryption
-- scheme defined in ADR-002. The KMS Key Encryption Key (KEK) referenced by
-- kek_key_id wraps the DEK; only an authorised KMS call can recover the
-- plaintext DEK. Compromising the database alone is insufficient to decrypt
-- PII ciphertext — that is the load-bearing security property.
--
-- See ADR-002 §3 for the schema decisions, rotation runbook, and crypto
-- rationale. NO bootstrap rows: DEK provisioning is an explicit operational
-- step performed by the rotation endpoint after KMS infrastructure is live.

CREATE TABLE "tenant_encryption_keys" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  "org_id"      UUID           NOT NULL,
  -- Monotonic rotation counter per (org, purpose). Starts at 1.
  "version"     INTEGER        NOT NULL,
  -- 'PII' | 'AUDIT' (text, not enum, for forward-compat per ADR-002 §3).
  "purpose"     TEXT           NOT NULL DEFAULT 'PII',
  -- KMS-wrapped 32-byte AES key. BYTEA: KMS ciphertext is binary.
  "wrapped_dek" BYTEA          NOT NULL,
  -- Production: AWS KMS key ARN. Dev: literal 'local-dev'.
  "kek_key_id"  TEXT           NOT NULL,
  -- Crypto-agility marker. Future: ChaCha20-Poly1305, post-quantum hybrid.
  "algorithm"   TEXT           NOT NULL DEFAULT 'AES-256-GCM',
  "is_active"   BOOLEAN        NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "retired_at"  TIMESTAMPTZ(6),
  CONSTRAINT "tenant_encryption_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_encryption_keys_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "tenant_encryption_keys_org_purpose_version_key"
  ON "tenant_encryption_keys"("org_id", "purpose", "version");

CREATE INDEX "tenant_encryption_keys_org_purpose_active_idx"
  ON "tenant_encryption_keys"("org_id", "purpose", "is_active");
