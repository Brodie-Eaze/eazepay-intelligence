#!/usr/bin/env bash
# Replica bootstrap. On first start (empty data dir), pg_basebackup clones
# the primary and writes the standby.signal file. Subsequent restarts
# resume from the WAL stream.
set -euo pipefail

PRIMARY_HOST="${PRIMARY_HOST:-postgres-primary}"
REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
REPL_PASS="${POSTGRES_REPLICATION_PASSWORD:-replicator}"
SLOT_NAME="${REPLICATION_SLOT_NAME:-replica_1}"

export PGUSER="$REPL_USER"
export PGPASSWORD="$REPL_PASS"

# Wait for the primary to be reachable before attempting basebackup.
until pg_isready -h "$PRIMARY_HOST" -U "$REPL_USER"; do
  echo "[replica] waiting for primary at $PRIMARY_HOST ..."
  sleep 1
done

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[replica] data dir empty — running pg_basebackup from $PRIMARY_HOST"
  rm -rf "$PGDATA"/*
  pg_basebackup \
    -h "$PRIMARY_HOST" \
    -D "$PGDATA" \
    -U "$REPL_USER" \
    -P -R -X stream \
    -S "$SLOT_NAME"
  # Ensure permissions postgres expects.
  chmod 0700 "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
fi

# Hand off to the official entrypoint with --hot-standby on.
exec docker-entrypoint.sh postgres -c hot_standby=on
