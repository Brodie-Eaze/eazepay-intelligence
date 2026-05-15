#!/usr/bin/env bash
# Run the multi-DB integration tests against a live primary + replica.
#
# 1. Brings up docker-compose.test.yml (primary, replica, redis)
# 2. Waits for replica to enter streaming mode
# 3. Runs `prisma migrate deploy` against the primary
# 4. Executes the integration test file
# 5. Tears down (preserves volumes only if KEEP_VOLUMES=1)
#
# Exits non-zero on any failure. Designed to be CI-runnable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE="docker compose -f docker-compose.test.yml"

teardown() {
  echo "[teardown] stopping test stack"
  if [[ "${KEEP_VOLUMES:-0}" == "1" ]]; then
    $COMPOSE down
  else
    $COMPOSE down -v
  fi
}
trap teardown EXIT

echo "[1/5] starting primary + replica + redis"
$COMPOSE up -d

echo "[2/5] waiting for primary"
for _ in $(seq 1 60); do
  if $COMPOSE exec -T postgres-primary pg_isready -U eazepay -d eazepay_intel >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[2/5] waiting for replica (must be streaming)"
for _ in $(seq 1 60); do
  state=$($COMPOSE exec -T postgres-primary psql -U eazepay -d eazepay_intel -tAc \
    "SELECT state FROM pg_stat_replication WHERE application_name = 'walreceiver' OR application_name LIKE '%replica%' LIMIT 1" 2>/dev/null || echo "")
  if [[ "$state" == "streaming" ]]; then
    echo "       replica is streaming"
    break
  fi
  sleep 1
done

echo "[3/5] applying migrations to primary"
DATABASE_URL="postgresql://eazepay:eazepay@localhost:55432/eazepay_intel?schema=public" \
  pnpm --filter api exec prisma migrate deploy

echo "[4/5] running integration tests"
DATABASE_URL="postgresql://eazepay:eazepay@localhost:55432/eazepay_intel?schema=public" \
DATABASE_REPLICA_URL="postgresql://eazepay:eazepay@localhost:55433/eazepay_intel?schema=public" \
REDIS_URL="redis://localhost:63790" \
PII_ENCRYPTION_KEY="$(node -e 'process.stdout.write(Buffer.alloc(32, 7).toString("base64"))')" \
PII_HASH_SECRET="integration-test-pepper-min-16-chars" \
JWT_ACCESS_SECRET="$(node -e 'process.stdout.write("a".repeat(32))')" \
JWT_REFRESH_SECRET="$(node -e 'process.stdout.write("b".repeat(32))')" \
BUZZPAY_WEBHOOK_SECRET="$(node -e 'process.stdout.write("c".repeat(32))')" \
PIXIE_WEBHOOK_SECRET="$(node -e 'process.stdout.write("d".repeat(32))')" \
MICAMP_WEBHOOK_SECRET="$(node -e 'process.stdout.write("e".repeat(32))')" \
EAZEPAY_APP_WEBHOOK_SECRET="$(node -e 'process.stdout.write("f".repeat(32))')" \
HIGHSALE_WEBHOOK_SECRET="$(node -e 'process.stdout.write("g".repeat(32))')" \
NODE_ENV=test \
  pnpm --filter api exec vitest run tests/integration/database-multi-live.test.ts

echo "[5/5] all integration tests passed"
