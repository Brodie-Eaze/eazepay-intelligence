#!/usr/bin/env bash
# Load: POST /integration/eazepay-app/events — HMAC + idempotency + outbox write.
#
# Pass criteria:
#   p95 < 500ms, p99 < 1s, errors = 0, cpu < 60%, redis_ops < 5k/s
#
# Run before flipping the eazepay_app role in production.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3010/api/v1}"
SECRET="${EAZEPAY_APP_WEBHOOK_SECRET:?required}"
DURATION="${DURATION:-30}"
CONNECTIONS="${CONNECTIONS:-20}"

ts=$(date +%s)
event_id=$(uuidgen | tr 'A-Z' 'a-z')

body=$(cat <<JSON
{"id":"${event_id}","eventId":"${event_id}","eventType":"application.offers_presented","subject":{"type":"Application","id":"${event_id}"},"data":{"applicationId":"${event_id}","brand":"medpay","offers":[]},"createdAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
)
sig=$(printf '%s' "${ts}.${body}" | openssl dgst -sha256 -hmac "${SECRET}" -hex | awk '{print $2}')

echo "▶ Load: POST /integration/eazepay-app/events"
echo "  duration=${DURATION}s connections=${CONNECTIONS}"
echo

# Note: this load generator sends the SAME event repeatedly which means
# idempotency-key dedup will mostly short-circuit after the first request.
# Realistic load needs a script that generates fresh idempotency keys —
# see `webhook-ingest-realistic.js` (TODO).
pnpm dlx autocannon@8 \
  -d "${DURATION}" \
  -c "${CONNECTIONS}" \
  -m POST \
  -H "Content-Type: application/json" \
  -H "x-eazepay-timestamp: ${ts}" \
  -H "x-eazepay-event-id: ${event_id}" \
  -H "x-eazepay-event-type: application.offers_presented" \
  -H "idempotency-key: load-test-${ts}-${event_id}" \
  -H "x-eazepay-signature: sha256=${sig}" \
  -b "${body}" \
  --renderStatusCodes \
  "${BASE_URL}/integration/eazepay-app/events"
