#!/usr/bin/env bash
# Load: GET /analytics/overview — RLS + per-org aggregate reads.
#
# Pass criteria:
#   p95 < 250ms, p99 < 500ms, errors = 0, cpu < 60%
#
# Run before flipping the eazepay_app role in production.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3010/api/v1}"
COOKIE="${COOKIE:-}"
DURATION="${DURATION:-60}"
CONNECTIONS="${CONNECTIONS:-50}"

if [[ -z "${COOKIE}" ]]; then
  echo "✗ COOKIE env var required (paste from a logged-in browser session)"
  exit 1
fi

echo "▶ Load: GET /analytics/overview"
echo "  url=${BASE_URL}/analytics/overview"
echo "  duration=${DURATION}s connections=${CONNECTIONS}"
echo "  pass: p95<250ms · p99<500ms · 0 errors"
echo

pnpm dlx autocannon@8 \
  -d "${DURATION}" \
  -c "${CONNECTIONS}" \
  -H "Cookie: ${COOKIE}" \
  --renderStatusCodes \
  "${BASE_URL}/analytics/overview"
