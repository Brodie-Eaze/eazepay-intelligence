# Runbook — deploy EazePay Intelligence to Railway

**Audience:** anyone shipping the platform to a live URL.
**Time to first deploy:** 20–30 min once you have a Railway account.
**Outcome:** a public URL Brodie can share with partners.

> This is the demo-readiness deploy. It does NOT cover the hardening
> work queued for after launch (KMS-backed secrets, AWS RDS instead of
> Railway Postgres, replica DSN, SOC 2 control evidence). Those land
> in a follow-up runbook once the platform is in front of paying eyes.

---

## 0. One-time prerequisites

1. Create a Railway account at <https://railway.com>. (I can't create
   the account for you — sign up yourself and add a payment method.
   The Hobby tier is fine for the demo.)
2. Connect your GitHub: Railway → **Account Settings → Integrations →
   GitHub** → authorise the `Brodie-Eaze/eazepay-intelligence` repo.
3. (Optional but recommended) Install the Railway CLI for ad-hoc
   inspection: `brew install railway` then `railway login`.

---

## 1. Generate the production secrets

Run from the repo root:

```bash
./scripts/generate-prod-secrets.sh > /tmp/eazepay-prod-secrets.env
```

This emits every secret the API needs (JWT keys, PII encryption key,
HMAC webhook secrets, KMS dev secret). **Store the output in 1Password
/ your password manager.** The PII encryption key in particular cannot
be rotated after data lands without re-encrypting every PII column.

---

## 2. Create the Railway project

1. Railway dashboard → **+ New project** → **Deploy from GitHub repo**.
2. Pick `Brodie-Eaze/eazepay-intelligence`.
3. Branch: `feat/portfolio-silos` (or `main` if you've merged).

Railway will auto-detect the monorepo. You'll add four services to it:

| Service  | Source           | Purpose                           |
| -------- | ---------------- | --------------------------------- |
| postgres | Railway plugin   | Database                          |
| redis    | Railway plugin   | BullMQ queues + idempotency cache |
| api      | Repo `/apps/api` | Fastify API server                |
| web      | Repo `/apps/web` | Next.js web app                   |

---

## 3. Provision Postgres + Redis

In the project canvas:

1. **+ New → Database → Add PostgreSQL.** Railway creates the service
   and exposes `DATABASE_URL`, `PGHOST`, etc. as service variables.
2. **+ New → Database → Add Redis.** Railway exposes `REDIS_URL` and
   `REDISHOST`/`REDISPORT`.

No further config needed for either. The API service will reference
them by Railway's templated variables in step 5.

---

## 4. Create the API service

1. **+ New → GitHub Repo → eazepay-intelligence.**
2. Service settings (gear icon) → **Settings**:
   - **Root Directory:** `apps/api`
   - **Build → Builder:** `Dockerfile`
   - **Build → Dockerfile Path:** `apps/api/Dockerfile`
   - **Build → Docker Build Context:** `.` (repo root)
   - Watch paths: `apps/api/**`, `package.json`, `pnpm-lock.yaml`
3. **Variables** tab. Paste the contents of
   `/tmp/eazepay-prod-secrets.env`, then add:

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   ```

   (Railway resolves `${{ServiceName.VARIABLE}}` at deploy time —
   service names match what you typed in step 3.)

4. **Networking** tab → **Generate Domain.** You'll get something like
   `eazepay-api-production.up.railway.app`. Copy this URL.
5. Back in **Variables**, set:

   ```
   APP_URL=https://<web-domain-from-step-6>.up.railway.app
   CORS_ORIGINS=https://<web-domain-from-step-6>.up.railway.app
   ```

   You'll fill these after step 6, but Railway lets you save with
   empty values for now.

6. Trigger a deploy. The `preDeployCommand` (defined in
   `apps/api/railway.json`) runs `prisma migrate deploy` before the
   container takes traffic — your schema lands automatically.

---

## 5. Create the Web service

1. **+ New → GitHub Repo → eazepay-intelligence** (yes, same repo —
   Railway will treat this as a second service).
2. Service settings:
   - **Root Directory:** `apps/web`
   - **Build → Builder:** `Dockerfile`
   - **Build → Dockerfile Path:** `apps/web/Dockerfile`
   - **Build → Docker Build Context:** `.` (repo root)
3. **Variables** tab. Web has FEWER runtime secrets because most of
   its config is baked at build time. Set:

   ```
   NODE_ENV=production
   NEXT_PUBLIC_ENV=production
   ```

   And **build args** (Railway → Build → Build Arguments — these are
   different from runtime variables; they're passed at `docker build`
   time):

   ```
   NEXT_PUBLIC_API_URL=https://<api-domain-from-step-4>.up.railway.app
   NEXT_PUBLIC_WS_URL=wss://<api-domain-from-step-4>.up.railway.app
   NEXT_PUBLIC_ENV=production
   ```

4. **Networking** → **Generate Domain.** Copy the URL.
5. Go back to **Step 4 → API service → Variables** and fill in the
   APP_URL + CORS_ORIGINS with this web domain. Trigger a redeploy of
   the API.
6. Trigger a deploy of the web service.

---

## 6. Seed the production database

Railway-managed Postgres is a fresh empty database. To get the demo
state (organizations, demo users, HighSale mock snapshots) into it:

```bash
# Set the production DATABASE_URL locally (from Railway → postgres → Connect)
export DATABASE_URL="postgresql://postgres:...@...railway.internal:5432/railway"

# 1. Bootstrap default org + demo users
pnpm --filter api db:seed

# 2. Provision the 7 launch businesses + per-org DEKs + ingestion PATs
pnpm --filter api db:seed:portfolio-orgs

# 3. Populate the holdco rollup
pnpm --filter api db:seed:portfolio-businesses

# 4. Seed 10 mock HighSale snapshots
pnpm --filter api db:seed:highsale-mock
```

The PAT plaintexts print to stdout — copy them into your password
manager. They never resurface from the database.

---

## 7. Smoke-test the deploy

```bash
# API health (no auth required)
curl https://<api-domain>.up.railway.app/health
# → 200 {"status":"ok",...}

# Web first paint
curl -sI https://<web-domain>.up.railway.app | head -3
# → HTTP/2 200, content-type: text/html
```

Open `https://<web-domain>.up.railway.app/login`. Sign in with the
seeded admin account:

- email: `admin@eazepay.local`
- password: `Demo!1234`

Land on `/overview`. You should see the warehouse landscape with row
counts > 0, and `/highsale` should list 10 mock applicants.

---

## 8. What to send partners

The URL: `https://<web-domain>.up.railway.app`
Demo credentials (rotate before any real customer sees them — see the
hardening runbook):

| Role     | Email                  | Password  |
| -------- | ---------------------- | --------- |
| Admin    | admin@eazepay.local    | Demo!1234 |
| Operator | operator@eazepay.local | Demo!1234 |
| Viewer   | viewer@eazepay.local   | Demo!1234 |
| Investor | investor@eazepay.local | Demo!1234 |

For partner-side **ingestion testing**, share the per-business PATs
that printed from `db:seed:portfolio-orgs`. They authenticate POSTs
to `/api/v1/ingestion/*`.

---

## 9. Updating after the first deploy

`feat/portfolio-silos` is the watched branch. Every push to GitHub
triggers:

1. Railway clones the repo, builds the affected service image
2. The API container runs `prisma migrate deploy` (release step)
3. Railway swaps traffic to the new container
4. Old container drains and dies

Migrations are forward-only — never re-order `prisma/migrations/*` or
edit an already-applied SQL file. Add a new migration instead.

---

## 10. Known gotchas

- **Build args vs runtime vars** on the web service: `NEXT_PUBLIC_*`
  bake into the JS bundle at build time. Setting them only as runtime
  variables means they'll be `undefined` in the client. Use the Build
  Arguments section.
- **CORS** — production CORS_ORIGINS must be the EXACT web origin
  including `https://` and no trailing slash. A mismatch silently
  rejects credentialed requests.
- **Trust proxy** — already configured (`trustProxy: true` on the
  Fastify instance). Without it, rate limiting would key on
  Railway's edge IP, not the real client.
- **Cookies** — secure + sameSite=none is required for cross-origin
  cookie auth on Railway (API and web have different `*.up.railway.app`
  subdomains). The API already sets these for production.
- **Worker processes** — the API container does NOT start BullMQ
  workers. For the demo, the in-process drain via WebhookProcessor
  handles inbound events synchronously. When you outgrow that, add a
  `worker` service that runs `pnpm --filter api worker:webhook`.

---

## 11. After the demo — hardening checklist

Queued for the hardening runbook (separate document, post-launch):

- [ ] Rotate the demo passwords; invite real users via the platform's
      invitation flow
- [ ] Replace LocalKmsClient with AwsKmsClient (real KMS-backed DEKs)
- [ ] Move PII encryption key to AWS Secrets Manager / Railway's
      shared-volume secret store
- [ ] Stand up a read replica for analytical queries
- [ ] Wire BullMQ workers as a separate Railway service
- [ ] Set up Sentry / Datadog / Honeycomb (OTEL_ENABLED=true)
- [ ] Configure Resend (RESEND_API_KEY) for real email
- [ ] Set up a custom domain (eazepay-intelligence.com) instead of
      the .up.railway.app subdomain
- [ ] Pen test + SOC 2 evidence collection (Vanta / Drata)
