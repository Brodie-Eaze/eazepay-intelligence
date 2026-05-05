# Runbook · EazePay Intelligence

The "what to do when X happens" reference. Each procedure is short, ordered, and copy-pasteable.

> **First-time readers:** start with [HANDOVER.md](HANDOVER.md) and [ONBOARDING.md](ONBOARDING.md). This file assumes you can already get the platform running locally.

---

## Index

- [Local development](#local-development)
- [Database operations](#database-operations)
- [Deployment](#deployment)
- [Rollback](#rollback)
- [Incident response](#incident-response)
- [Common debugging](#common-debugging)
- [Webhook operations](#webhook-operations)
- [Auth + access management](#auth--access-management)
- [PII access requests (DSAR)](#pii-access-requests-dsar)
- [Secrets rotation](#secrets-rotation)

---

## Local development

| Task                           | Command                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| First-time setup               | `make setup`                                                      |
| Start everything               | `make dev` (or `pnpm dev`)                                        |
| Restart Postgres + Redis       | `make services-down && make services-up`                          |
| Reset database to seeded state | `make db-reset`                                                   |
| Run a single worker            | `make worker-webhook` (or `worker-aggregation`, `worker-revenue`) |
| Open Prisma Studio             | `make db-studio`                                                  |
| Run typecheck                  | `make typecheck`                                                  |
| Run tests                      | `make test`                                                       |

---

## Database operations

### Add a migration after schema change

```bash
# Edit apps/api/prisma/schema.prisma
make db-migrate    # auto-generates migration name prompt
```

### Apply migrations to staging / prod

```bash
DATABASE_URL=<prod-url> pnpm --filter api exec prisma migrate deploy
psql "$DATABASE_URL" -f apps/api/prisma/init-timescale.sql
```

### Inspect production data ad-hoc (read-only)

```bash
DATABASE_URL=<readonly-url> pnpm --filter api exec prisma studio
```

Connect with the read-only role (not `eazepay_app`, not `eazepay_owner`).

### Backfill / data fix

1. Write a TypeScript script under `apps/api/scripts/<name>.ts`.
2. Use the existing `getPrisma()` singleton.
3. Wrap in a transaction.
4. Run with `DATABASE_URL=<env-url> pnpm --filter api exec tsx scripts/<name>.ts`.
5. Commit the script (audit trail).

---

## Deployment

> Production target not yet picked. The procedure below is the _intended_ shape; concrete commands land when we provision Fly / Railway / ECS.

### Staging deploy

```bash
git push origin main                     # CI triggers staging build
gh run watch                             # observe CI
# auto-deploys to staging on green build
```

### Production deploy (manual gate)

```bash
git tag v0.x.y                           # semver
git push origin v0.x.y
# CI builds + tags Docker image
# Triggers production deploy via approval gate
```

### Post-deploy verification

1. `curl https://<prod>/health` → expect `{ status: "ok", checks: { database: ok, redis: ok } }`
2. `curl https://<prod>/api/v1/auth/me` with a known cookie → expect 200
3. Send a test webhook with a known idempotency key and confirm it appears in `/ops/webhooks`
4. Pull `/ops/health` for queue depth and webhook health summary
5. Check `audit_logs` for `WEBHOOK_RECEIVED` rows in the last minute

---

## Rollback

### Application rollback

```bash
gh release list                          # find the previous good tag
gh workflow run deploy.yml -f tag=v0.x.(y-1)
```

### Database rollback

**The database is generally not rolled back. Migrations should be additive and backwards-compatible.** If a migration must be rolled back:

```bash
# Pre-condition: previous migration is reversible (Prisma generates reversible
# DDL by default, except for column drops)
DATABASE_URL=<prod-url> pnpm --filter api exec prisma migrate resolve --rolled-back <migration-name>
```

Then deploy the previous app version.

For destructive migrations, restore from the most recent `pg_dump`:

```bash
pg_restore --clean --no-owner -d <prod-db> <dump-file>
psql "$DATABASE_URL" -f apps/api/prisma/init-timescale.sql
```

### Webhook replay after recovery

After any database restore, identify webhook events that arrived during the affected window:

```sql
SELECT id, source, event_type, idempotency_key, received_at, status
FROM webhook_events
WHERE received_at BETWEEN '<incident-start>' AND '<incident-end>'
  AND status != 'PROCESSED';
```

Re-enqueue via the worker's replay function (UI button: pending — see KNOWN_ISSUES).

---

## Incident response

### Severity levels

| Level | Definition                                                      | Response time        |
| ----- | --------------------------------------------------------------- | -------------------- |
| SEV-1 | Platform down / data loss / PII breach                          | Immediate, all hands |
| SEV-2 | Webhook ingestion failing > 10% / dashboard down for some users | < 30 min             |
| SEV-3 | Single feature broken / non-blocking                            | Same business day    |

### SEV-1 first 30 minutes

1. **Acknowledge** in the on-call channel (when established). Open a war room.
2. **Stop the bleeding.** If active data loss / breach: rotate the implicated secrets immediately.
3. **Snapshot evidence:**
   ```bash
   psql "$DATABASE_URL" -c "\\COPY (SELECT * FROM audit_logs WHERE created_at > now() - interval '2 hours') TO 'audit-snap.csv' CSV HEADER;"
   psql "$DATABASE_URL" -c "\\COPY (SELECT * FROM webhook_events WHERE received_at > now() - interval '2 hours') TO 'webhook-snap.csv' CSV HEADER;"
   ```
4. **Communicate:** internal first, then partners (BuzzPay / HighSale / MiCamp), then upstream consumers if affected.
5. **Postmortem within 5 business days** (template in `docs/postmortem-template.md` — pending).

### Suspected PII breach

Per `PRIVACY.md` + `SECURITY.md`:

1. Identify the scope: query `audit_logs WHERE action='PII_ACCESSED'` for the suspect window.
2. Rotate `PII_ENCRYPTION_KEY` (register v2 in `encryption.ts`, leave v1 active for read until backfill).
3. **Notify the OAIC within 72 hours** under the Notifiable Data Breaches scheme (Privacy Act §26WL).
4. Notify partners-of-origin so they can notify data subjects.
5. Preserve all `audit_logs` and `webhook_events` rows from the window — these are the forensic record.

### Webhook flood / abuse

1. Identify the source from `webhook_events.source` + IP from logs.
2. Rotate the implicated `*_WEBHOOK_SECRET` to break the attacker's HMAC.
3. Coordinate with the legitimate vendor to issue them the new secret out-of-band.
4. Optionally: Cloudflare rule to block the source IP at the edge.

### Refresh-token theft suspected

The system auto-detects: any reuse of a revoked refresh token revokes the entire family. Operator action:

1. `SELECT * FROM audit_logs WHERE action='USER_REFRESHED' AND created_at > now() - '24h' ORDER BY created_at DESC` to find suspicious bursts.
2. Manually revoke all sessions for affected users:
   ```sql
   UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = '<id>' AND revoked_at IS NULL;
   ```
3. Force password reset.

---

## Common debugging

### "I deployed but the dashboard shows stale data"

Likely Redis cache. The analytics endpoints have a 30s TTL. Either wait 30s or:

```bash
redis-cli -u "$REDIS_URL" --scan --pattern 'cache:analytics:*' | xargs redis-cli -u "$REDIS_URL" del
```

### "WS connection drops every few seconds"

Check the JWT TTL on the access cookie. If access expired and refresh isn't rotating, the WS gateway will reject reconnects. Inspect:

```bash
curl -i -H "Cookie: epi_access=<>" https://<prod>/api/v1/auth/me
```

If 401: refresh flow is broken.

### "Webhook returns 401 INVALID_SIGNATURE"

Most common cause: timestamp drift. Check vendor's clock vs our clock:

```bash
curl -sI https://<prod>/health   # check Date header
```

±5 minutes is the tolerance window. If the vendor's clock is more than 5 min off, fix on their side.

### "Prisma errors with Bytea / Buffer"

PII columns are `Bytes`. Ensure you're calling `encryptPII()` before insert and `decryptPII()` for reads. The encryption helper rejects malformed envelopes (too short, unknown key version) — log the actual error.

### "Queue is backing up"

1. Check worker is running: `ps aux | grep worker:webhook`
2. Check Redis: `redis-cli -u "$REDIS_URL" llen bull:eazepay.webhook:wait`
3. Check failed jobs: `redis-cli -u "$REDIS_URL" llen bull:eazepay.webhook:failed`
4. If failed: inspect via the UI at `/ops/webhooks` (filter `status=FAILED`) — `processingError` column has the message
5. Scale workers: run additional `pnpm --filter api worker:webhook` processes in parallel (BullMQ partitions automatically)

---

## Webhook operations

### Send a test webhook locally

```bash
TS=$(date +%s)
BODY='{"externalApplicationId":"APP-TEST-1","partnerExternalId":"PRT-0001","consumer":{"name":"Test","email":"t@e.local","phone":"+61400000000"}}'
SIG=$(echo -n "${TS}.${BODY}" | openssl dgst -sha256 -hmac "$BUZZPAY_WEBHOOK_SECRET" -hex | awk '{print $2}')
curl -X POST http://localhost:3010/api/v1/webhooks/buzzpay/application \
  -H "Content-Type: application/json" \
  -H "X-Eazepay-Signature: $SIG" \
  -H "X-Eazepay-Timestamp: $TS" \
  -H "Idempotency-Key: test-$(uuidgen)" \
  -d "$BODY"
```

### Find a stuck event

```sql
SELECT id, source, event_type, status, processing_error, received_at, processed_at
FROM webhook_events
WHERE status IN ('RECEIVED', 'FAILED')
  AND received_at < now() - interval '5 minutes'
ORDER BY received_at DESC;
```

---

## Auth + access management

### Add a new operator

- UI: `/admin → New user → fill email + password + role → Create`. Audit row written.
- API: `POST /api/v1/users` (admin-only).

### Rotate an operator's password

- UI: not yet exposed.
- API: `PATCH /api/v1/users/:id { password: "new" }`.
- Forces no immediate re-login (existing access cookie remains valid until expiry, max 15 min). To force logout: revoke their refresh tokens.

### Revoke all sessions for a user

```sql
UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = '<id>' AND revoked_at IS NULL;
```

### Disable MFA on a locked-out account

**Admin-only, manual, audit-logged externally:**

```sql
UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = '<id>';
INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, metadata, created_at)
VALUES (gen_random_uuid(), '<your-admin-id>', 'USER_MFA_DISABLED', 'user', '<id>', '{"reason":"manual_recovery"}', now());
```

---

## PII access requests (DSAR)

When a customer requests their data via a partner:

1. Operator identifies the customer's email (the partner provides).
2. Compute the email hash:
   ```bash
   PII_HASH_SECRET=<env-value> node -e "console.log(require('crypto').createHmac('sha256', process.env.PII_HASH_SECRET).update(process.argv[1].toLowerCase().trim()).digest('hex'))" "<email>"
   ```
3. Query `GET /api/v1/customers/<hash>` for the structured profile.
4. Query `GET /api/v1/customers/<hash>/pii` for plaintext (audit-logged).
5. Export as JSON; deliver via secure channel.
6. Document the fulfilment in `audit_logs` (the `PII_ACCESSED` rows already capture this).

Erasure requests (right-to-be-forgotten): not yet implemented. ROADMAP P2.

---

## Secrets rotation

### Webhook source secret (BuzzPay / Pixie / MiCamp)

1. Coordinate cutover window with vendor.
2. Generate new secret (32+ bytes random).
3. Update vendor-side first; configure their staging to send with new secret.
4. Update env on our side; redeploy.
5. Validate one test event end-to-end.
6. Vendor flips production to new secret.

### `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`

Rotation invalidates all access cookies (access tokens) and refresh tokens. Plan a maintenance window or implement RS256 + KMS first.

### `PII_ENCRYPTION_KEY`

1. Generate new 32-byte key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Register v2 in `apps/api/src/shared/utils/encryption.ts` `loadKeyVersions()`.
3. Set `VERSION_CURRENT = 0x02`. New writes use v2; reads honour the per-row version byte.
4. Deploy.
5. Optional backfill: rewrite v1 ciphertext as v2 over time (script).
6. **Do not delete v1 from `KEY_VERSIONS` until 100% of ciphertext has been re-encrypted** (any v1 row becomes unreadable).

### `PII_HASH_SECRET`

**Don't.** Rotation requires re-hashing every PII row, which is destructive to the hash → row index. If absolutely needed, plan a maintenance window with a backfill script that:

1. Reads ciphertext, decrypts to plaintext
2. Re-hashes with new secret
3. Updates `*_hash` columns
4. Atomically swaps the active secret

---

## "How would you know if this broke at 3am?"

Today's honest answer: **you wouldn't, unless someone calls.** Production deploy must wire alerting before going live. The `/admin/health` dashboard surfaces every signal we'd want to alert on:

| Signal                                        | Threshold | Alert action                          |
| --------------------------------------------- | --------- | ------------------------------------- |
| Webhook success rate (24h) < 99%              | warn      | route to on-call                      |
| Webhook success rate (24h) < 95%              | page      | wake someone                          |
| Webhook backlog > 100                         | warn      | route to on-call                      |
| DB latency p95 > 100ms                        | warn      | inspect                               |
| Failed login rate (1h) > 100                  | warn      | possible attack                       |
| `PII_ACCESSED` events from one user > 50/hour | page      | possible insider threat               |
| Queue `webhook` failed jobs > 0               | warn      | inspect; auto-retry handles transient |
| `/health` returns non-200 for > 60s           | page      | platform down                         |

Wire these via OpenTelemetry → Honeycomb / Datadog (P1 in ROADMAP).
