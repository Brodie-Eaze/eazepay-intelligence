#!/usr/bin/env bash
# Generate every secret the API needs for a production deploy.
#
# Usage:
#   ./scripts/generate-prod-secrets.sh
#
# Emits a `.env.production.generated` block you paste into Railway's
# service "Variables" tab. Run ONCE per environment and store the output
# in a password manager — the encryption keys cannot be regenerated
# without re-encrypting every PII column.
#
# Secrets generated:
#   JWT_ACCESS_SECRET            (32 bytes)
#   JWT_REFRESH_SECRET           (32 bytes)
#   PII_ENCRYPTION_KEY           (32 bytes, base64)
#   PII_HASH_SECRET              (32 bytes)
#   EAZEPAY_APP_WEBHOOK_SECRET   (64 bytes)
#   HIGHSALE_WEBHOOK_SECRET      (64 bytes)
#   BUZZPAY_WEBHOOK_SECRET       (32 bytes — retiring, see docs/cuts/buzzpay-removal.md)
#   PIXIE_WEBHOOK_SECRET         (32 bytes)
#   MICAMP_WEBHOOK_SECRET        (32 bytes)
#   KMS_DEV_SECRET               (32 bytes — only for LocalKmsClient; AWS KMS in real prod)
set -euo pipefail

if ! command -v openssl >/dev/null; then
  echo "openssl required" >&2
  exit 1
fi

rand() {
  # $1 = byte length, $2 = encoding (hex|base64)
  if [[ "$2" == "base64" ]]; then
    openssl rand -base64 "$1"
  else
    openssl rand -hex "$1"
  fi
}

cat <<EOF
# ──────────────────────────────────────────────────────────────────────────
# EazePay Intelligence — production secrets
# Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
#
# Paste into Railway → API service → Variables.
# Mirror EAZEPAY_APP_WEBHOOK_SECRET into EazePay App's environment.
# ──────────────────────────────────────────────────────────────────────────

NODE_ENV=production
LOG_LEVEL=info
PORT=3010

# ─── Auth ─────────────────────────────────────────────────────────────────
JWT_ACCESS_SECRET=$(rand 32 hex)
JWT_REFRESH_SECRET=$(rand 32 hex)
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=604800

# ─── PII encryption (AES-256-GCM) ─────────────────────────────────────────
# REGENERATING this key after data has landed RENDERS EXISTING PII UNREADABLE.
# Treat as a single-occurrence write. Store in your password manager.
PII_ENCRYPTION_KEY=$(rand 32 base64)
PII_HASH_SECRET=$(rand 32 hex)

# ─── Webhook signing (HMAC-SHA-256 shared secrets) ────────────────────────
# Each value below MUST be mirrored into the corresponding upstream:
#   EAZEPAY_APP_WEBHOOK_SECRET  → EazePay App env (var name there:
#                                  EAZEPAY_INTELLIGENCE_SINK_SECRET)
#   HIGHSALE_WEBHOOK_SECRET     → HighSale outbound dispatcher
#   PIXIE_WEBHOOK_SECRET        → Pixie outbound webhooks
#   MICAMP_WEBHOOK_SECRET       → MiCamp outbound webhooks
# BUZZPAY_WEBHOOK_SECRET is retired (see docs/cuts/buzzpay-removal.md) —
# generated for backward compat until Phase B removal lands.
EAZEPAY_APP_WEBHOOK_SECRET=$(rand 64 hex)
HIGHSALE_WEBHOOK_SECRET=$(rand 64 hex)
BUZZPAY_WEBHOOK_SECRET=$(rand 32 hex)
PIXIE_WEBHOOK_SECRET=$(rand 32 hex)
MICAMP_WEBHOOK_SECRET=$(rand 32 hex)

# ─── KMS (dev fallback — replace with AWS KMS in real prod) ───────────────
KMS_DEV_SECRET=$(rand 32 hex)

# ─── Runtime tuning ───────────────────────────────────────────────────────
DATABASE_SLOW_QUERY_LOG_MS=500
RATE_LIMIT_PER_IP_PER_MIN=100
RATE_LIMIT_PER_USER_PER_MIN=1000
RATE_LIMIT_INGESTION_PER_MIN=6000
RATE_LIMIT_WEBHOOK_PER_MIN=10000
BODY_LIMIT_DEFAULT_BYTES=1048576
BODY_LIMIT_BULK_BYTES=8388608
BODY_LIMIT_WEBHOOK_BYTES=2097152
WORKER_WEBHOOK_CONCURRENCY=10
WORKER_DELIVERY_CONCURRENCY=20
WORKER_OUTBOX_BATCH=100
DEFAULT_CURRENCY=AUD
REPORTING_CURRENCY=AUD
PIXIE_VOLUME_BREAKPOINT=25000
PIXIE_COST_PER_PULL=1.00
PIXIE_CHARGE_PER_PULL=3.00
OTEL_ENABLED=false
INVITATION_TTL_HOURS=168
MAIL_FROM=EazePay Intelligence <noreply@eazepay.local>

# ──────────────────────────────────────────────────────────────────────────
# DO NOT paste these as-is — set them after the web service has its URL:
# ──────────────────────────────────────────────────────────────────────────
# DATABASE_URL=<auto-injected by Railway Postgres>
# REDIS_URL=<auto-injected by Railway Redis>
# APP_URL=https://<web-service>.up.railway.app
# CORS_ORIGINS=https://<web-service>.up.railway.app
# NEXT_PUBLIC_API_URL=https://<api-service>.up.railway.app  (build-arg on web)
# NEXT_PUBLIC_WS_URL=wss://<api-service>.up.railway.app     (build-arg on web)
EOF
