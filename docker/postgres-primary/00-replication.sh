#!/usr/bin/env bash
# Primary bootstrap. Runs once at first container start (Postgres
# entrypoint copies anything in /docker-entrypoint-initdb.d into the
# init order). Creates a dedicated replication role and grants the
# wire-protocol REPLICATION privilege, then opens pg_hba so the replica
# can stream WAL.
set -euo pipefail

REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
REPL_PASS="${POSTGRES_REPLICATION_PASSWORD:-replicator}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASS}';
  -- Allow standby to advance the timeline + reuse a slot across reconnects.
  SELECT pg_create_physical_replication_slot('replica_1', true);
SQL

# Open replication on the docker network. md5 here is fine for a test-only
# stack; production uses scram-sha-256 + per-host certs.
{
  echo "host replication ${REPL_USER} 0.0.0.0/0 md5"
  echo "host replication ${REPL_USER} ::/0 md5"
} >> "$PGDATA/pg_hba.conf"
