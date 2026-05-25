/**
 * Engineering reference data for Eaze Intelligence.
 *
 * Source of truth for the public `/engineering-reference` page. Mirrors
 * `docs/ENGINEERING_REFERENCE.md`. Edit both in lockstep.
 */

export type Actor = 'OPERATOR' | 'EAZEPAY' | 'VENDOR' | 'EXTERNAL' | 'LENDER' | 'SYSTEM';

export type CardKind = 'HTTP' | 'SYSTEM' | 'DATA' | 'EXTERNAL' | 'NOTIFY' | 'WORKER' | 'PAGE';

export interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  note?: string;
}

export interface TableRef {
  name: string;
  description: string;
}

export interface SurfaceTag {
  kind: CardKind;
  label: string;
  sub?: string;
}

export interface FlowStep {
  index: string; // e.g. "1.1"
  actor: Actor;
  title: string;
  description: string;
  tags?: SurfaceTag[];
  endpoints?: Endpoint[];
  tables?: TableRef[];
  code?: { lang: string; body: string; title?: string };
}

export interface FlowPhase {
  index: number;
  title: string;
  blurb: string;
  steps: FlowStep[];
}

export interface ReferenceCard {
  index: string;
  actor: Actor;
  title: string;
  whatItDoes: string;
  whatItsFor: string;
  appearsIn?: string[]; // flow phase titles
  tags?: SurfaceTag[];
  endpoints?: Endpoint[];
  tables?: TableRef[];
}

export interface ReferenceSection {
  index: string;
  title: string;
  blurb: string;
  cards: ReferenceCard[];
}

export const FLOW: FlowPhase[] = [
  {
    index: 1,
    title: 'Inbound — vendors deliver',
    blurb:
      'How upstream data lands on the platform. Five inbound planes, each with its own HMAC contract.',
    steps: [
      {
        index: '1.1',
        actor: 'VENDOR',
        title: 'EazePay App · application-lifecycle webhooks',
        description:
          'EazePay App POSTs every state transition: application.offers_presented, application.contracted, application.declined, application.funded, merchant.onboarded, merchant.status_changed, revenue.recorded, loan.repayment.*. Body = canonical envelope. Tenant resolution today is via data.brand body field (deferred to SEC-005 per-tenant credential migration).',
        endpoints: [
          {
            method: 'POST',
            path: '/api/v1/integration/eazepay-app/events',
            note: 'HMAC-SHA-256 signed',
          },
        ],
      },
      {
        index: '1.2',
        actor: 'VENDOR',
        title: 'HighSale · credit-data snapshots',
        description:
          'HighSale (EZ Check) POSTs the full credit-data snapshot per applicant after the bureau pull completes. Body is ~70 fields. PII (name/email/phone) encrypted at rest via per-org DEK; non-PII columns are queryable directly.',
        endpoints: [
          {
            method: 'POST',
            path: '/api/v1/integration/highsale/snapshots',
            note: 'HMAC-SHA-256 signed',
          },
        ],
      },
      {
        index: '1.3',
        actor: 'VENDOR',
        title: 'MiCamp · processing webhooks',
        description:
          'Card processing fees + reversals. Two endpoints. 50/50 revenue share with partner is materialised per event.',
        endpoints: [
          { method: 'POST', path: '/api/v1/webhooks/micamp/processing-completed' },
          { method: 'POST', path: '/api/v1/webhooks/micamp/processing-reversed' },
        ],
      },
      {
        index: '1.4',
        actor: 'VENDOR',
        title: 'Pixie · usage metering',
        description:
          'Pre-qualification pulls. Sub-second hot path, partner-level visibility. Fires on every Pixie API call from a partner integration.',
        endpoints: [{ method: 'POST', path: '/api/v1/webhooks/pixie/usage-reported' }],
      },
      {
        index: '1.5',
        actor: 'SYSTEM',
        title: 'Lenders · polling adapters',
        description:
          "Lenders don't push — we pull. Per-lender adapter polls each lender's reporting API on a 15-minute cron, normalises to lender_reporting_events shape.",
        tags: [
          {
            kind: 'WORKER',
            label: 'lender-polling.worker.ts',
            sub: '15-minute cron · adapter registry',
          },
        ],
      },
      {
        index: '1.6',
        actor: 'OPERATOR',
        title: 'Ingestion · PAT-driven bulk + single',
        description:
          'Authenticated equivalent of the signed-webhook path for devs + ETL workers. Bearer-token (PAT) auth, same downstream processing.',
        endpoints: [
          { method: 'POST', path: '/api/v1/ingestion/{source}/events', note: 'Bearer PAT' },
          { method: 'POST', path: '/api/v1/ingestion/{source}/bulk', note: 'Bearer PAT' },
        ],
      },
    ],
  },
  {
    index: 2,
    title: 'Verify — signature + replay + tenancy',
    blurb: 'What happens to every inbound webhook before a single byte is persisted.',
    steps: [
      {
        index: '2.1',
        actor: 'SYSTEM',
        title: 'Raw-body capture',
        description:
          "Server-level content-type parser retains req.rawBody (the exact bytes the vendor signed) alongside the parsed body. Without this, JSON.stringify(parsed) ≠ vendor's signed input and every signature would fail on non-canonical JSON.",
        tags: [{ kind: 'SYSTEM', label: 'apps/api/src/server.ts content-type parser override' }],
      },
      {
        index: '2.2',
        actor: 'SYSTEM',
        title: 'HMAC verification',
        description:
          "Every receiver computes HMAC-SHA-256(secret, ts + '.' + rawBody) and timingSafeEqual compares it against the vendor's signature header. Length-equality pre-check before timingSafeEqual so the comparison itself is constant-time.",
        tags: [{ kind: 'SYSTEM', label: 'Constant-time compare · clock-skew tolerance 5min' }],
      },
      {
        index: '2.3',
        actor: 'SYSTEM',
        title: 'Timestamp tolerance',
        description:
          'Math.abs(now - ts) > 300 rejects replay attempts older than 5 minutes. Pinned at the receiver, separate from the HMAC.',
        tags: [{ kind: 'SYSTEM', label: 'TOLERANCE_SECONDS = 300' }],
      },
      {
        index: '2.4',
        actor: 'SYSTEM',
        title: 'Idempotency-key shape gate',
        description:
          'Every receiver enforces /^[A-Za-z0-9_-]{16,128}$/ on the idempotency-key header BEFORE any Redis or DB touch. Without this, a signed sender could SETNX multi-MB keys and balloon Redis memory.',
        tags: [{ kind: 'SYSTEM', label: 'IDEMPOTENCY_KEY_RE · pre-Redis gate' }],
      },
      {
        index: '2.5',
        actor: 'SYSTEM',
        title: 'Two-layer dedup · Redis SETNX → DB unique',
        description:
          'Layer 1: Redis SET key NX EX 86400 is the hot path. Layer 2: Postgres unique on (org_id, source, idempotency_key) is the source-of-truth backstop on Redis miss. The Redis layer serialises concurrent identical requests; the DB unique catches everything Redis missed.',
        tags: [{ kind: 'SYSTEM', label: 'Redis SETNX + Postgres unique constraint' }],
      },
      {
        index: '2.6',
        actor: 'EAZEPAY',
        title: 'WebhookEvent row written',
        description:
          'Source-of-truth INSERT into webhook_events. This row is what the drain worker consumes downstream. Raw payload is purged after 90 days by the lifecycle worker.',
        tables: [
          {
            name: 'webhook_events',
            description:
              'id, org_id, source, event_type, idempotency_key, signature_valid, payload',
          },
        ],
      },
    ],
  },
  {
    index: 3,
    title: 'Quarantine — failed-event triage',
    blurb:
      'When verification passes but downstream normalisation fails, the event lands in quarantine for operator triage instead of being silently dropped or replayed forever.',
    steps: [
      {
        index: '3.1',
        actor: 'EAZEPAY',
        title: 'Brand quarantine (EazePay App)',
        description:
          "If data.brand doesn't map to any known org, the event lands in eazepay_app_quarantine with reason brand_unknown. Operator can either re-assign to a real org OR delete.",
        tables: [{ name: 'eazepay_app_quarantine', description: 'per-row reason + raw payload' }],
      },
      {
        index: '3.2',
        actor: 'EAZEPAY',
        title: 'Outbox DLQ',
        description:
          'The cross-system outbox writer dispatches to registered subscribers. Rows that exceed max retries land in outbox_events.status = DLQ. Operators view + replay via /platform/quarantine.',
        tables: [{ name: 'outbox_events', description: 'DLQ status · operator-triaged' }],
      },
      {
        index: '3.3',
        actor: 'OPERATOR',
        title: 'Platform quarantine UI',
        description:
          'Lists both quarantine kinds with replay actions. Replay requires MFA step-up — these are SUPER actions.',
        tags: [{ kind: 'PAGE', label: '/platform/quarantine · MFA-gated replay' }],
      },
    ],
  },
  {
    index: 4,
    title: 'Drain — workers normalise into the domain model',
    blurb: 'Workers consume WebhookEvent rows and write to the typed domain tables.',
    steps: [
      {
        index: '4.1',
        actor: 'SYSTEM',
        title: 'webhook.worker.ts',
        description:
          'Generic webhook drain. Pulls webhook_events rows that need processing, dispatches by source + eventType to the right handler. BullMQ-backed, 10 concurrent jobs default.',
        tags: [{ kind: 'WORKER', label: 'concurrency = 10 · Redis-backed' }],
      },
      {
        index: '4.2',
        actor: 'SYSTEM',
        title: 'EazePay App processor',
        description:
          'Wraps every drain inside withTenantSession(prisma, {orgId}, ...) so RLS context is set before any write. 8 event-type handlers: offers_presented, contracted, declined, funded, merchant.onboarded, merchant.status_changed, revenue.recorded, loan.repayment.*.',
        tags: [{ kind: 'SYSTEM', label: 'EazepayAppProcessor.process(job)' }],
      },
      {
        index: '4.3',
        actor: 'SYSTEM',
        title: 'HighSale processor',
        description:
          'Snapshot lands in credit_enrichments table. PII columns encrypted via encryptForOrg(orgId, plaintext) using AES-GCM under the per-org DEK. Hash columns (consumer_email_hash, consumer_phone_hash) computed via HMAC-keyed SHA256 for indexable lookup.',
        tags: [{ kind: 'SYSTEM', label: 'Per-org DEK envelope encryption' }],
      },
      {
        index: '4.4',
        actor: 'SYSTEM',
        title: 'MiCamp + Pixie processors',
        description:
          'Smaller — these vendors only emit revenue / usage events. Each writes one row to the append-only revenue_events ledger.',
        tables: [
          {
            name: 'revenue_events',
            description: 'append-only · TimescaleDB hypertable · partitioned by month',
          },
        ],
      },
      {
        index: '4.5',
        actor: 'SYSTEM',
        title: 'Outbox writer',
        description:
          'Every domain write that needs to fan out appends to outbox_events in the SAME transaction as the domain write. Two-phase commit substitute — if the domain row landed, the outbox row landed too.',
        tags: [{ kind: 'SYSTEM', label: 'Outbox pattern · transactional consistency' }],
      },
      {
        index: '4.6',
        actor: 'SYSTEM',
        title: 'Outbox sweeper',
        description:
          'outbox.worker.ts polls outbox_events WHERE status=PENDING every 1s, FOR UPDATE SKIP LOCKED for non-overlapping batches across replicas, dispatches to subscribers, marks SENT or retries. DLQ after max attempts.',
        tags: [{ kind: 'WORKER', label: '1s sweep · 100 events/batch · ~6000 ev/min/replica' }],
      },
    ],
  },
  {
    index: 5,
    title: 'Encrypt — PII envelope crypto',
    blurb: 'How consumer PII gets locked down at write time.',
    steps: [
      {
        index: '5.1',
        actor: 'EAZEPAY',
        title: 'Tenant DEK lookup',
        description:
          'Every encryption call resolves the per-org DEK from tenant_encryption_keys. The DEK is wrapped under the platform KMS root key — only KMS can unwrap.',
        tables: [
          { name: 'tenant_encryption_keys', description: 'one active row per org · KMS-wrapped' },
        ],
      },
      {
        index: '5.2',
        actor: 'SYSTEM',
        title: 'KMS factory',
        description:
          'Picks driver from KMS_DRIVER env (aws | local) or auto-selects aws for NODE_ENV=production. Local path derives KEK via HKDF-SHA-256 from KMS_DEV_SECRET — dev/test only, refuses to construct in production.',
        tags: [{ kind: 'SYSTEM', label: 'AWS in prod · local-HKDF in dev' }],
      },
      {
        index: '5.3',
        actor: 'SYSTEM',
        title: 'AES-256-GCM envelope',
        description:
          'encryptForOrg(orgId, plaintext) produces a v2 envelope: [0x02, alg, keyId, iv, ct, tag]. Tag enforced at 16 bytes via { authTagLength: 16 } — closed against truncated-tag forgery (CWE-310).',
        tags: [{ kind: 'SYSTEM', label: 'CWE-310 closed · semgrep gcm-no-tag-length: 0 findings' }],
      },
      {
        index: '5.4',
        actor: 'SYSTEM',
        title: 'Hash for indexable lookup',
        description:
          'For columns we need to query without decrypting (e.g. "find customer by email hash"), we store hashPII(plaintext) = HMAC-SHA256(PII_HASH_SECRET, normalised). The pepper makes rainbow-table attacks against a leaked DB infeasible.',
        tags: [{ kind: 'SYSTEM', label: 'hashPII · HMAC-keyed · indexable' }],
      },
      {
        index: '5.5',
        actor: 'SYSTEM',
        title: 'Decryption hot path',
        description:
          "decryptEnvelopeAuto(prisma, envelope, decryptFn) dispatches by envelope version byte. v1 → legacy global key. v2 → per-org DEK. Both share the read path so callers don't case-switch.",
        tags: [{ kind: 'SYSTEM', label: 'decryptEnvelopeAuto · version-byte dispatch' }],
      },
    ],
  },
  {
    index: 6,
    title: 'RLS — every query is org-scoped at the DB layer',
    blurb:
      'Defence-in-depth multi-tenancy. Application-layer where: { orgId } is the first line; RLS is the database backstop.',
    steps: [
      {
        index: '6.1',
        actor: 'SYSTEM',
        title: 'eazepay_app runtime role',
        description:
          'The API connects as eazepay_app NOBYPASSRLS role (separate from the owner role used by prisma migrate deploy). Without BYPASSRLS, every query is subject to the policies. Provisioned via migration 20260517100000_phase1_6_eazepay_app_role + ops sets the password out-of-band.',
        tags: [{ kind: 'SYSTEM', label: 'NOBYPASSRLS · REVOKE UPDATE/DELETE on audit_logs' }],
      },
      {
        index: '6.2',
        actor: 'SYSTEM',
        title: 'withTenantSession',
        description:
          "SET LOCAL app.org_id = '<uuid>' runs at the start of every tenant-scoped Prisma transaction. RLS policies compare org_id::text = current_setting('app.org_id', TRUE) and return zero rows otherwise.",
        tags: [{ kind: 'SYSTEM', label: 'withTenantSession wrapper · per-transaction GUC' }],
      },
      {
        index: '6.3',
        actor: 'SYSTEM',
        title: 'Policies on every tenant table',
        description:
          '~25 tables under FOR ALL policies. Platform staff bypass for cross-tenant operator workflows; bypass is audited via app.platform_staff GUC.',
        tables: [{ name: '~25 tables', description: 'RLS policies enforced at DB role level' }],
      },
      {
        index: '6.4',
        actor: 'SYSTEM',
        title: 'Startup self-check',
        description:
          'assertRuntimeDbRoleNotBypassRls() runs at boot in production and refuses to start if the connected role has rolbypassrls = true. Stops a silent regression where ops forgets to switch DATABASE_URL to the runtime role.',
        tags: [{ kind: 'SYSTEM', label: 'RLS guard at boot · refuses prod start on misconfig' }],
      },
    ],
  },
  {
    index: 7,
    title: 'Real-time — three places at once',
    blurb:
      'One event publish, multiple subscribers (operator dashboards, audit firehose, outbound webhooks).',
    steps: [
      {
        index: '7.1',
        actor: 'EAZEPAY',
        title: 'publishWsEvent envelope',
        description:
          'Every event published to the internal Redis pub/sub goes through publishWsEvent(orgId, event) which wraps as {orgId, event} on the wire. The envelope is what the WS gateway uses to filter per-tenant on send.',
        tags: [{ kind: 'SYSTEM', label: 'ws-publisher.ts · tenant-aware envelope' }],
      },
      {
        index: '7.2',
        actor: 'EAZEPAY',
        title: 'WS ticket issuance',
        description:
          'POST /api/v1/auth/ws/ticket (auth-cookie + CSRF gated) mints a 30-second single-use JWT with kind=ws_ticket. Embeds userId, scope, orgId. consumeWsTicket does GETDEL so the token is truly single-use.',
        endpoints: [
          { method: 'POST', path: '/api/v1/auth/ws/ticket', note: '30s TTL · GETDEL single-use' },
        ],
      },
      {
        index: '7.3',
        actor: 'EAZEPAY',
        title: 'WS gateway',
        description:
          '/api/v1/ws/analytics?ticket=... accepts the ticket, parses orgId, attaches to per-connection ClientCtx. Redis subscriber loops shouldDeliverToClient(c, envelope) — platform-staff (orgId=null) see everything, tenant-scoped clients only see their orgId.',
        endpoints: [
          { method: 'GET', path: '/api/v1/ws/analytics', note: 'WebSocket · ticket-auth' },
        ],
      },
      {
        index: '7.4',
        actor: 'EAZEPAY',
        title: 'Outbound webhook fan-out',
        description:
          'OutboundWebhookService.dispatch(orgId, eventType, payload) queries subscriptions WHERE org_id = ? AND event_types @> ARRAY[?] and enqueues a webhook-delivery BullMQ job per subscriber. Worker signs each delivery with subscriber secret and POSTs with exp-backoff retry.',
        tags: [{ kind: 'WORKER', label: 'webhook-delivery.worker.ts · exp-backoff · DLQ on fail' }],
      },
      {
        index: '7.5',
        actor: 'EAZEPAY',
        title: 'Audit firehose',
        description:
          'Every state change writes one audit_logs row via writeAuditLog. Action enum: USER_LOGIN, PII_ACCESSED, WEBHOOK_RECEIVED, EXPORT_REQUESTED, RTBF_PROCESSED, etc. PII-free metadata by contract (only hashes + IDs).',
        tables: [
          { name: 'audit_logs', description: 'append-only · 70+ action types · DB-role immutable' },
        ],
      },
    ],
  },
  {
    index: 8,
    title: 'Surfacing — operator reads the data',
    blurb: 'How the normalised data reaches the operator dashboard.',
    steps: [
      {
        index: '8.1',
        actor: 'OPERATOR',
        title: 'Next.js 14 web app',
        description:
          'apps/web is a Next.js 14 app-router SPA. ~70 pages. TanStack Query for server-state, Tailwind for styling, dark-mode default. Authenticates via __Host-epi_access cookie. Every page → /auth/me → either redirect to /login or proceed.',
        tags: [{ kind: 'PAGE', label: 'apps/web · 70+ pages' }],
      },
      {
        index: '8.2',
        actor: 'SYSTEM',
        title: 'Reader / writer split',
        description:
          'getPrismaReader() routes to DATABASE_REPLICA_URL when set (lag-tolerant analytics + dashboard reads). Falls back to writer on replica failure. Reader runtime-guards write actions.',
        tags: [{ kind: 'SYSTEM', label: 'Postgres writer/reader split · graceful fallback' }],
      },
      {
        index: '8.3',
        actor: 'SYSTEM',
        title: 'Live WebSocket',
        description:
          'Dashboard pages that need live data (/overview, /live, /applications/by-status, /platform/quarantine) open one WS connection at mount and consume the WsEvent discriminated union.',
        tags: [{ kind: 'SYSTEM', label: '/ws/analytics · 15s heartbeat' }],
      },
      {
        index: '8.4',
        actor: 'OPERATOR',
        title: 'Investor scope',
        description:
          "A user can toggle scope='investor' (read-only, partner labels anonymised). The toggle re-issues an access token under a new family (independent revocation) and the WS gateway applies scopeForInvestor(event) before sending. Investor accounts can NEVER drop back to standard scope.",
        tags: [{ kind: 'SYSTEM', label: 'Scope toggle · partnerLabel anonymisation' }],
      },
    ],
  },
  {
    index: 9,
    title: 'Operator actions — write-side flows',
    blurb: 'What an operator can DO (vs. read).',
    steps: [
      {
        index: '9.1',
        actor: 'OPERATOR',
        title: 'PII reveal · /customers/:hash/pii',
        description:
          'Decrypts consumer name/email/phone for a customer hash. Gated on auth.orgRole (ADMIN or OPERATOR in active org) AND scoped to orgId so same hash in sibling org is NOT revealed. Writes a PII_ACCESSED audit log with field list.',
        endpoints: [
          {
            method: 'GET',
            path: '/api/v1/customers/:hash/pii',
            note: 'MFA-step-up may be required',
          },
        ],
      },
      {
        index: '9.2',
        actor: 'OPERATOR',
        title: 'Export job',
        description:
          'Operator requests an export with format (CSV / JSONL) + filter. Enqueues an export-pipeline BullMQ job. Worker runs as eazepay_worker_long role (5-min statement_timeout), streams 5000-row batches, writes to local disk OR S3 per EXPORT_STORAGE_DRIVER. Operator gets notification when ready; presigned URL TTL configurable.',
        tags: [{ kind: 'WORKER', label: 'export.worker.ts · long-running role · S3 storage' }],
      },
      {
        index: '9.3',
        actor: 'OPERATOR',
        title: 'Scheduled report',
        description:
          "Operator configures a daily/weekly cron in /reports. scheduled-report.worker.ts runs '0 * * * *' (every hour) and dispatches reports whose next_run_at <= now(). Sends to configured notification channels.",
        tags: [{ kind: 'WORKER', label: 'scheduled-report.worker.ts · hourly cron' }],
      },
      {
        index: '9.4',
        actor: 'OPERATOR',
        title: 'RTBF (Right To Be Forgotten)',
        description:
          'Operator submits an email hash via /admin/rtbf (MFA-gated). lifecycle.worker.ts finds every Application carrying that consumerEmailHash and overwrites encrypted PII columns with zero buffers in one transaction. AES-GCM tag is part of the ciphertext bytes — zeroing the column makes the data cryptographically unrecoverable. Application row + downstream FKs preserved for 7-year regulatory retention.',
        tags: [{ kind: 'SYSTEM', label: 'cryptoshred · 7y retention of non-PII trail' }],
      },
      {
        index: '9.5',
        actor: 'OPERATOR',
        title: 'Outbox replay / DLQ replay',
        description:
          'DLQ rows can be re-queued from /platform/quarantine. MFA step-up required. Resets the row attempt_count and the next sweep picks it up.',
        endpoints: [
          {
            method: 'POST',
            path: '/api/v1/platform/outbox/dlq/:id/replay',
            note: 'MFA-gated',
          },
        ],
      },
    ],
  },
  {
    index: 10,
    title: 'Lifecycle — retention + scrub + cleanup',
    blurb: 'Background workers that keep the platform tidy.',
    steps: [
      {
        index: '10.1',
        actor: 'SYSTEM',
        title: 'Webhook payload TTL',
        description:
          'lifecycle.worker.ts clears raw webhook_events.payload JSON after 90 days. Keeps the row (audit + idempotency lookup) but drops the bulky payload column.',
        tags: [{ kind: 'WORKER', label: 'lifecycle.worker.ts · 90-day payload scrub' }],
      },
      {
        index: '10.2',
        actor: 'SYSTEM',
        title: 'Refresh token expiry',
        description:
          'Expired and revoked refresh tokens are purged. Reduces table bloat over the 7-day refresh TTL window.',
        tags: [{ kind: 'WORKER', label: 'lifecycle.worker.ts · refresh-token GC' }],
      },
      {
        index: '10.3',
        actor: 'SYSTEM',
        title: 'Aggregation rollups',
        description:
          'aggregation.worker.ts rolls up revenue_events into revenue_aggregations (monthly per-partner totals). TimescaleDB continuous aggregate revenue_daily_cagg handles daily buckets.',
        tags: [{ kind: 'WORKER', label: 'aggregation.worker.ts · monthly rollups' }],
      },
      {
        index: '10.4',
        actor: 'SYSTEM',
        title: 'Lender polling',
        description:
          'lender-polling.worker.ts polls every active lender adapter on a 15-minute cron. Each adapter normalises the vendor reporting payload into lender_reporting_events rows.',
        tags: [{ kind: 'WORKER', label: 'lender-polling.worker.ts · per-lender cron' }],
      },
      {
        index: '10.5',
        actor: 'OPERATOR',
        title: 'Reconciliation',
        description:
          '/platform/reconciliation shows revenue_events SUM vs. revenue_aggregations SUM per month. Drift > $0.005 means either the aggregation worker fell behind OR something bypassed the ledger.',
        tags: [{ kind: 'PAGE', label: '/platform/reconciliation · books-tied-out check' }],
      },
    ],
  },
  {
    index: 11,
    title: 'Workers + queues',
    blurb: 'Async backbone. BullMQ on Redis. 13 worker processes today.',
    steps: [
      {
        index: '11.1',
        actor: 'SYSTEM',
        title: 'Worker process list',
        description:
          'webhook · webhook-delivery · outbox · export · aggregation · lifecycle · alert · scheduled-report · lender-polling · pii-reencryption · correlation-linker · revenue · retention. Each is its own process (Railway intel service deploys the fleet).',
        tags: [{ kind: 'SYSTEM', label: '13 BullMQ workers · Redis-backed' }],
      },
      {
        index: '11.2',
        actor: 'OPERATOR',
        title: 'Queue health UI',
        description:
          '/ops/queues shows job counts (waiting, active, completed, failed, delayed), retry rates, throughput per worker.',
        tags: [{ kind: 'PAGE', label: '/ops/queues · queue-by-queue health' }],
      },
      {
        index: '11.3',
        actor: 'SYSTEM',
        title: 'Dead-letter queue',
        description:
          "outbox_events.status='DLQ' rows are the queue-level DLQ. Operator-triaged via /platform/quarantine.",
        tables: [{ name: 'outbox_events', description: 'DLQ status · operator replay' }],
      },
      {
        index: '11.4',
        actor: 'SYSTEM',
        title: 'Graceful shutdown',
        description:
          'Every worker has hardened SIGTERM/SIGINT handlers: try { await worker.close(); process.exit(0); } catch { log.error; process.exit(1); }. Hard-exits on close-rejection (Redis-disconnect race) so orchestrator restarts cleanly.',
        tags: [{ kind: 'SYSTEM', label: '4 workers hardened post silent-failure audit' }],
      },
    ],
  },
  {
    index: 12,
    title: 'Tracking · observability · ops',
    blurb: 'Every action above leaves a trail.',
    steps: [
      {
        index: '12.1',
        actor: 'EAZEPAY',
        title: 'Audit log',
        description:
          'Every actor action writes one audit_logs row (append-only by DB grant — eazepay_app role lacks UPDATE/DELETE). SOC 2 CC7.3 + FCRA evidence. ~70 action types.',
        tags: [{ kind: 'PAGE', label: '/audit · /audit/logins · /audit/pii' }],
      },
      {
        index: '12.2',
        actor: 'EAZEPAY',
        title: 'Alert engine',
        description:
          'alert.worker.ts evaluates rules from alert_rules on a per-rule cadence. Metrics: webhook failure rate, webhook event count, failed login count, application count, revenue amount, PII access count, ingestion rejected count, replication lag ms. Fires alerts row + notification channel dispatch on HIT.',
        tags: [{ kind: 'WORKER', label: 'alert.worker.ts · rule-driven · auto-resolve' }],
      },
      {
        index: '12.3',
        actor: 'SYSTEM',
        title: 'Metrics endpoint',
        description:
          '/metrics exposes Prometheus-format counters/histograms. Bearer-auth via METRICS_BEARER_TOKEN so the labels (lender slugs, orgs, error ids) are not a public recon goldmine.',
        endpoints: [{ method: 'GET', path: '/metrics', note: 'METRICS_BEARER_TOKEN gated' }],
      },
      {
        index: '12.4',
        actor: 'SYSTEM',
        title: 'Health',
        description:
          'Returns Postgres replica lag + Redis ping + worker queue depth. Used by Railway healthcheck.',
        endpoints: [{ method: 'GET', path: '/api/v1/health' }],
      },
      {
        index: '12.5',
        actor: 'OPERATOR',
        title: 'Activity firehose',
        description:
          '/live page subscribes to the WS feed and shows every event flowing through the platform. Vibe-check / sales-room TV view.',
        tags: [{ kind: 'PAGE', label: '/live · WS-subscribed firehose' }],
      },
      {
        index: '12.6',
        actor: 'OPERATOR',
        title: 'Webhook log',
        description:
          '/ops/webhooks shows every raw inbound webhook across every signed-webhook source. signature_valid + response_status per row.',
        tags: [{ kind: 'PAGE', label: '/ops/webhooks · inbound webhook log' }],
      },
    ],
  },
];

export const REFERENCE: ReferenceSection[] = [
  {
    index: 'B1',
    title: 'Inbound data planes · public-signed',
    blurb: 'Every public-facing webhook receiver. HMAC-signed. Stateless. Idempotent.',
    cards: [
      {
        index: '1.1',
        actor: 'VENDOR',
        title: 'EazePay App webhook receiver',
        whatItDoes:
          'Receives every application-lifecycle event from the EazePay App platform. 8 event types covering application state transitions + merchant lifecycle + revenue + loan repayments.',
        whatItsFor: 'Single source of truth for application-level state in the warehouse.',
        appearsIn: ['Flow 01 · Inbound', 'Flow 02 · Verify', 'Flow 04 · Drain'],
        endpoints: [{ method: 'POST', path: '/api/v1/integration/eazepay-app/events' }],
      },
      {
        index: '1.2',
        actor: 'VENDOR',
        title: 'HighSale snapshot receiver',
        whatItDoes:
          'Receives the post-bureau-pull credit-data snapshot per applicant. ~70 fields per snapshot. PII encrypted at rest.',
        whatItsFor:
          'Credit-profile enrichment of every application — the data that powers risk-band, propensity-calibration, and income-distribution analytics.',
        appearsIn: ['Flow 01 · Inbound', 'Flow 04 · Drain', 'Flow 05 · Encrypt'],
        endpoints: [{ method: 'POST', path: '/api/v1/integration/highsale/snapshots' }],
      },
      {
        index: '1.3',
        actor: 'VENDOR',
        title: 'MiCamp processing receivers',
        whatItDoes:
          'Card processing fees + reversals. Drives 50/50 revenue share materialisation per partner.',
        whatItsFor:
          'Realised revenue tracking — the difference between "lender funded" and "money in the bank."',
        appearsIn: ['Flow 01 · Inbound', 'Flow 04 · Drain'],
        endpoints: [
          { method: 'POST', path: '/api/v1/webhooks/micamp/processing-completed' },
          { method: 'POST', path: '/api/v1/webhooks/micamp/processing-reversed' },
        ],
      },
      {
        index: '1.4',
        actor: 'VENDOR',
        title: 'Pixie usage receiver',
        whatItDoes: 'Pre-qualification usage metering. Sub-second hot path.',
        whatItsFor: 'Partner-level usage visibility + per-partner pre-qual cost attribution.',
        appearsIn: ['Flow 01 · Inbound', 'Flow 04 · Drain'],
        endpoints: [{ method: 'POST', path: '/api/v1/webhooks/pixie/usage-reported' }],
      },
      {
        index: '1.5',
        actor: 'OPERATOR',
        title: 'Generic ingestion (PAT)',
        whatItDoes:
          'Authenticated equivalent of the signed-webhook path. Bearer-token (PAT) + idempotency-key + raw-body capture. Same downstream processing as webhooks.',
        whatItsFor: 'Backfills, ETL workers, dev integration. Not for vendor traffic.',
        appearsIn: ['Flow 01 · Inbound'],
        endpoints: [
          { method: 'POST', path: '/api/v1/ingestion/{source}/events' },
          { method: 'POST', path: '/api/v1/ingestion/{source}/bulk' },
        ],
      },
      {
        index: '1.6',
        actor: 'VENDOR',
        title: 'Aurean AI / Aurean Recruitment receivers',
        whatItDoes:
          'Phase-H integrations for sibling-brand business events. Same signed-webhook pattern; per-source schema.',
        whatItsFor: 'Cross-brand ops visibility once the Aurean platforms emit native webhooks.',
        appearsIn: ['Flow 01 · Inbound'],
      },
    ],
  },
  {
    index: 'B2',
    title: 'Auth & multi-tenancy',
    blurb:
      'How a request goes from "someone hit our API" to "this is user X in org Y with role Z."',
    cards: [
      {
        index: '2.1',
        actor: 'EAZEPAY',
        title: 'Local password login',
        whatItDoes:
          'POST /api/v1/auth/login validates (email, password, mfaCode?), issues an access JWT (15min) + refresh token (7d) + CSRF token, sets all three as __Host- prefixed cookies.',
        whatItsFor: 'Primary user-auth path for ops + admins.',
        endpoints: [{ method: 'POST', path: '/api/v1/auth/login' }],
      },
      {
        index: '2.2',
        actor: 'EAZEPAY',
        title: 'Google OAuth',
        whatItDoes:
          "OAuth 2.0 + PKCE with Google. Sign-in only (never auto-creates users). Matches first on email (creates sub mapping), then on sub thereafter so a compromised email can't redirect a Google session to a different account. Domain allow-list defence-in-depth on top of Google's hd claim.",
        whatItsFor: "SSO for orgs that don't want password management.",
        endpoints: [
          { method: 'GET', path: '/api/v1/auth/oauth/google/start' },
          { method: 'GET', path: '/api/v1/auth/oauth/google/callback' },
          { method: 'GET', path: '/api/v1/auth/oauth/providers' },
        ],
      },
      {
        index: '2.3',
        actor: 'EAZEPAY',
        title: 'MFA setup + verify',
        whatItDoes:
          'TOTP via otplib. /auth/mfa/setup generates a secret + QR code. /auth/mfa/verify accepts the first code and flips users.mfa_enabled=true.',
        whatItsFor: 'Per-user TOTP enrollment.',
        endpoints: [
          { method: 'POST', path: '/api/v1/auth/mfa/setup' },
          { method: 'POST', path: '/api/v1/auth/mfa/verify' },
        ],
      },
      {
        index: '2.4',
        actor: 'EAZEPAY',
        title: 'MFA step-up',
        whatItDoes:
          "Issues a 5-minute single-use token (HMAC-signed) for SUPER actions. Atomically dedup'd via Redis SET jti EX <ttl> NX so the token can't be replayed across multi-pod deployments. Falls back to in-process Map if Redis is unreachable.",
        whatItsFor:
          'Cryptoshred, RTBF, quarantine replay, impersonation-token issue — anything that needs proof of "the human at the keyboard authorised THIS request right now."',
        endpoints: [
          { method: 'POST', path: '/api/v1/auth/mfa/step-up/start' },
          { method: 'POST', path: '/api/v1/auth/mfa/step-up/verify' },
        ],
      },
      {
        index: '2.5',
        actor: 'OPERATOR',
        title: 'Personal Access Tokens',
        whatItDoes:
          "Mint a epi_pk_<prefix>_<secret> bearer token. Storage = HMAC-pepper'd hash. Per-token scopes (READ / WRITE / SUPER).",
        whatItsFor: 'Programmatic access — ingestion workers, integration partners.',
        endpoints: [
          { method: 'POST', path: '/api/v1/api-tokens' },
          { method: 'GET', path: '/api/v1/api-tokens' },
          { method: 'DELETE', path: '/api/v1/api-tokens/:id' },
        ],
      },
      {
        index: '2.6',
        actor: 'OPERATOR',
        title: 'Session management',
        whatItDoes:
          'Per-session refresh-token family. Rotation on every refresh; reuse → revoke family. Deny-list for immediate revocation. /auth/sessions lists active sessions per user.',
        whatItsFor: 'Logout-from-all-devices + session inventory.',
        endpoints: [
          { method: 'GET', path: '/api/v1/auth/sessions' },
          { method: 'DELETE', path: '/api/v1/auth/sessions/:id' },
        ],
      },
      {
        index: '2.7',
        actor: 'SYSTEM',
        title: 'RBAC + RLS multi-tenancy',
        whatItDoes:
          'Three layers: (1) requireAuth → JWT + DB user check + Membership re-check; (2) resolveTenantFromPath for /o/:orgSlug/* routes — loads org + Membership, populates req.auth.orgId/orgRole; (3) Postgres RLS policies enforce the same boundary at the DB.',
        whatItsFor:
          'Defence-in-depth multi-tenancy. App layer + DB layer must BOTH agree before a query returns a row.',
        appearsIn: ['Flow 06 · RLS'],
      },
      {
        index: '2.8',
        actor: 'EAZEPAY',
        title: 'Cookies',
        whatItDoes:
          'Three cookies set per session: __Host-epi_access (15min, httpOnly), __Host-epi_refresh (7d, httpOnly), __Host-epi_csrf (15min, JS-readable for double-submit). __Host- prefix blocks sibling-subdomain overshadow attacks.',
        whatItsFor:
          'Browser-side auth state. CSRF token is the double-submit gate on every state-changing route.',
      },
    ],
  },
  {
    index: 'B3',
    title: 'Operator web app · /',
    blurb:
      'Every page in apps/web. Single SPA, dark-mode default, TanStack Query for server-state.',
    cards: [
      {
        index: '3.1',
        actor: 'OPERATOR',
        title: '/overview',
        whatItDoes:
          'Holdco dashboard. KPI cards (apps last 24h, revenue MTD, lender approval rate, WS connection health). Real-time event ticker.',
        whatItsFor: 'First stop on login. The "is everything OK" snapshot.',
      },
      {
        index: '3.2',
        actor: 'OPERATOR',
        title: '/data-sources (+ per-source detail)',
        whatItDoes:
          'Hub page showing every inbound plane with last-24h event count, last-received timestamp, HEALTHY/STALE/IDLE pill. Drill-in pages for eazepay-app, highsale, pixie, micamp, lenders, partners.',
        whatItsFor:
          'Where your data comes from — answers "is HighSale sending us anything?" at a glance.',
        appearsIn: ['Flow 01 · Inbound', 'Flow 04 · Drain'],
      },
      {
        index: '3.3',
        actor: 'OPERATOR',
        title: '/applications + /applications/by-status',
        whatItDoes:
          'Application book + status-column kanban view. Tenant-scoped (post-SEC-002 fix).',
        whatItsFor: 'Application pipeline visibility per tenant.',
      },
      {
        index: '3.4',
        actor: 'OPERATOR',
        title: '/customers family',
        whatItDoes:
          'Customer book (by email hash), detail page (full application history + credit timeline + total funded), PII reveal (/customers/:hash/pii — MFA + role-gated), credit-enrichment timeline, lender-data timeline. All routes tenant-scoped at both Prisma + raw-SQL layers.',
        whatItsFor: 'Per-consumer ops + PII reveal under compliance trail.',
        appearsIn: ['Flow 08 · Surfacing', 'Flow 09 · Operator actions'],
      },
      {
        index: '3.5',
        actor: 'OPERATOR',
        title: '/revenue family',
        whatItDoes:
          'Revenue event ledger (/revenue/ledger), per-stream breakdowns (/revenue/streams), reconciliation page — ledger SUM vs. rollup SUM per month, drift > $0.005 flagged.',
        whatItsFor: 'Money tracking + books-tie-out.',
        appearsIn: ['Flow 10 · Lifecycle'],
      },
      {
        index: '3.6',
        actor: 'OPERATOR',
        title: '/analytics (risk / income / propensity)',
        whatItDoes:
          'Aggregate analytics: risk-distribution, income-distribution, propensity-calibration. All tenant-scoped (post-SEC-002).',
        whatItsFor: 'Portfolio analytics for risk + sales teams.',
      },
      {
        index: '3.7',
        actor: 'OPERATOR',
        title: '/partners',
        whatItDoes:
          'Partner directory + per-partner page (apps, revenue, lender mix, pixie usage). Brand-anonymised in investor scope.',
        whatItsFor: 'Partner ops + commercial terms.',
      },
      {
        index: '3.8',
        actor: 'OPERATOR',
        title: '/lenders family',
        whatItDoes:
          'Lender panel, per-adapter health (/lenders/adapters), submit reporting events (/lenders/submit).',
        whatItsFor: 'Lender ops + reporting-API debug.',
        appearsIn: ['Flow 01 · Inbound (1.5)', 'Flow 10 · Lifecycle'],
      },
      {
        index: '3.9',
        actor: 'OPERATOR',
        title: '/highsale + /highsale/schema',
        whatItDoes:
          'HighSale snapshot detail viewer + schema explorer for the ~70 fields HighSale emits.',
        whatItsFor: 'Per-applicant credit-profile drilldown.',
      },
      {
        index: '3.10',
        actor: 'OPERATOR',
        title: '/platform/*',
        whatItDoes:
          '/platform/quarantine (failed-event triage), /platform/orgs (multi-tenant admin), /platform/reconciliation (books tie-out). All actions MFA-step-up gated.',
        whatItsFor: 'SUPER ops surfaces.',
        appearsIn: ['Flow 03 · Quarantine'],
      },
      {
        index: '3.11',
        actor: 'OPERATOR',
        title: '/audit family',
        whatItDoes:
          '/audit (every action), /audit/logins (auth events), /audit/pii (PII-access trail).',
        whatItsFor: 'SOC 2 / FCRA compliance evidence + "who did what when."',
        appearsIn: ['Flow 12 · Tracking'],
      },
      {
        index: '3.12',
        actor: 'OPERATOR',
        title: '/ops/*',
        whatItDoes:
          '/ops/health, /ops/queues (BullMQ status), /ops/sessions (session inventory), /ops/webhooks (inbound webhook log).',
        whatItsFor: "On-call engineer's pager-page.",
        appearsIn: ['Flow 11 · Workers + queues', 'Flow 12 · Tracking'],
      },
      {
        index: '3.13',
        actor: 'OPERATOR',
        title: '/exports',
        whatItDoes:
          'Request + download exports. List of all exports, status, presigned download URL.',
        whatItsFor: 'Operator data-out flow.',
        appearsIn: ['Flow 09 · Operator actions (9.2)'],
      },
      {
        index: '3.14',
        actor: 'OPERATOR',
        title: '/reports + /alerts',
        whatItDoes:
          'Configure scheduled reports (cron + channel + filter + format) + alert rules (metric + threshold + cadence + channel).',
        whatItsFor: 'Recurring data-out + self-service ops monitoring.',
        appearsIn: ['Flow 09 · Operator actions', 'Flow 12 · Tracking'],
      },
      {
        index: '3.15',
        actor: 'OPERATOR',
        title: '/settings/*',
        whatItDoes:
          'Per-user settings: MFA setup, sessions, API tokens, OAuth links, default org, notification prefs.',
        whatItsFor: 'Self-service account management.',
      },
      {
        index: '3.16',
        actor: 'OPERATOR',
        title: '/live',
        whatItDoes: 'WS-subscribed activity firehose. Every event scrolling past.',
        whatItsFor: 'Sales-room TV; engineer debug feed.',
        appearsIn: ['Flow 07 · Real-time'],
      },
      {
        index: '3.17',
        actor: 'OPERATOR',
        title: '/search + /portfolio + /kpis/* + /funnel + /income + /propensity + /risk',
        whatItDoes:
          'Specialist analytics + cross-domain search + per-brand KPI rollups for sibling Aurean platforms + portfolio rollups.',
        whatItsFor: 'Specialist surfaces for risk / commercial / investor teams.',
      },
    ],
  },
  {
    index: 'B4',
    title: 'Domain APIs · /api/v1/*',
    blurb: 'Every Fastify route module under apps/api/src/domains. 26 route files.',
    cards: [
      {
        index: '4.1',
        actor: 'EAZEPAY',
        title: 'auth.routes.ts + oauth.routes.ts',
        whatItDoes:
          'Local login, MFA setup + step-up, session list, refresh, logout, OAuth start/callback. Composite rate-limited (per-user + per-IP).',
        whatItsFor: 'All auth surfaces.',
        appearsIn: ['Flow 08 · Surfacing'],
      },
      {
        index: '4.2',
        actor: 'EAZEPAY',
        title: 'applications.routes.ts',
        whatItDoes:
          'Application list (paginated, filterable by status), detail, lender-decision sub-resource.',
        whatItsFor: 'Operator pipeline + drilldown.',
        appearsIn: ['Flow 08 · Surfacing'],
      },
      {
        index: '4.3',
        actor: 'EAZEPAY',
        title: 'customers.routes.ts',
        whatItDoes:
          'Customer book + detail + PII reveal + credit-enrichment + lender-data. Tenant-scoped at every query (post-SEC-002).',
        whatItsFor: 'Per-consumer ops.',
      },
      {
        index: '4.4',
        actor: 'EAZEPAY',
        title: 'revenue.routes.ts',
        whatItDoes: 'Revenue events list, per-stream rollups, reconciliation queries.',
        whatItsFor: 'Money tracking.',
      },
      {
        index: '4.5',
        actor: 'EAZEPAY',
        title: 'partners.routes.ts',
        whatItDoes: 'Partner CRUD + per-partner analytics.',
        whatItsFor: 'Partner ops.',
      },
      {
        index: '4.6',
        actor: 'EAZEPAY',
        title: 'lenders.routes.ts',
        whatItDoes:
          'Lender panel + adapter health + submit reporting events + funding/decision routes.',
        whatItsFor: 'Lender ops.',
      },
      {
        index: '4.7',
        actor: 'EAZEPAY',
        title: 'pixie.routes.ts + micamp.routes.ts',
        whatItDoes: 'Vendor-specific routes for adapter-driven flows.',
        whatItsFor: 'Per-vendor query surfaces.',
      },
      {
        index: '4.8',
        actor: 'EAZEPAY',
        title: 'webhooks.routes.ts',
        whatItDoes:
          'Vendor-webhook receivers for MiCamp + Pixie. (EazePay App + HighSale have their own route modules under integration/.)',
        whatItsFor: 'Inbound webhook handling.',
        appearsIn: ['Flow 01 · Inbound', 'Flow 02 · Verify'],
      },
      {
        index: '4.9',
        actor: 'OPERATOR',
        title: 'ingestion.routes.ts',
        whatItDoes: 'PAT-driven generic ingestion. Single-event + bulk endpoints per source.',
        whatItsFor: 'ETL + backfill path.',
      },
      {
        index: '4.10',
        actor: 'EAZEPAY',
        title: 'outbound-webhooks.routes.ts',
        whatItDoes: 'Outbound subscriptions CRUD + delivery log.',
        whatItsFor: 'Customer-configured event fan-out.',
        appearsIn: ['Flow 07 · Real-time (7.4)'],
      },
      {
        index: '4.11',
        actor: 'OPERATOR',
        title:
          'exports.routes.ts + scheduled-reports.routes.ts + alerts.routes.ts + rtbf.routes.ts',
        whatItDoes:
          'Operator-action surfaces. Exports request + download, scheduled report CRUD, alert rule CRUD, RTBF submission + status.',
        whatItsFor: 'Write-side flows.',
        appearsIn: ['Flow 09 · Operator actions'],
      },
      {
        index: '4.12',
        actor: 'EAZEPAY',
        title: 'admin.routes.ts + platform.routes.ts',
        whatItDoes:
          'Platform-staff cross-tenant admin routes. Tenant offboarding, org provisioning, secret rotation, replication-lag queries, KMS rotation.',
        whatItsFor: 'SUPER ops.',
      },
      {
        index: '4.13',
        actor: 'EAZEPAY',
        title:
          'users.routes.ts + invitations + analytics + health + notes + tags + search + portfolio + fx',
        whatItDoes:
          'User CRUD per org + invitation flow + aggregate analytics + health probes + cross-domain annotation + tagging + search + portfolio rollups + FX rate lookup.',
        whatItsFor: 'Catch-all domain modules.',
      },
    ],
  },
  {
    index: 'B5',
    title: 'Backend systems · no UI',
    blurb: 'The headless services + middleware.',
    cards: [
      {
        index: '5.1',
        actor: 'SYSTEM',
        title: 'Fastify server bootstrap',
        whatItDoes:
          'Single buildServer() factory. Plugin order LOCKED: helmet → cors → sensible → rate-limit → websocket → auth → routes. Per-request UUIDv7 IDs. 60s plugin timeout (raised 2026-05-24 for Redis cold-start). Decimal reply serializer preserves Prisma Decimal precision.',
        whatItsFor: 'Single entry point for both production server + integration tests.',
      },
      {
        index: '5.2',
        actor: 'SYSTEM',
        title: 'KMS factory',
        whatItDoes:
          'Picks AWS KMS or local KMS by env. Driver bootstrap fail-fast on missing config in production (AWS_KMS_KEY_ARN required) — softened to warn under 2026-05-24 env relaxation.',
        whatItsFor: 'Per-org DEK envelope encryption root.',
        appearsIn: ['Flow 05 · Encrypt (5.2)'],
      },
      {
        index: '5.3',
        actor: 'SYSTEM',
        title: 'Per-org DEK envelope',
        whatItDoes:
          'AES-256-GCM with 16-byte tag enforced. Version-byte dispatch on decrypt (v1 legacy / v2 per-org / v3 AAD planned per ADR-006).',
        whatItsFor: 'PII encryption.',
        appearsIn: ['Flow 05 · Encrypt'],
      },
      {
        index: '5.4',
        actor: 'SYSTEM',
        title: 'Outbox dispatcher',
        whatItDoes:
          'Transactional outbox writer + sweeper. Guarantees domain row landed → outbox row landed too. Sweeper uses FOR UPDATE SKIP LOCKED for non-overlapping multi-replica batching.',
        whatItsFor: 'Cross-system write durability.',
        appearsIn: ['Flow 04 · Drain (4.5, 4.6)'],
      },
      {
        index: '5.5',
        actor: 'SYSTEM',
        title: 'Pino logger',
        whatItDoes:
          'Structured JSON logging with PII redaction. ~200 redact paths covering every consumer-PII field name, crypto envelope material, env-shaped secrets, vendor signature headers, raw bodies. Contract regression test covers 70 cases.',
        whatItsFor: 'Observability with compliance guarantees.',
        appearsIn: ['Flow 12 · Tracking'],
      },
      {
        index: '5.6',
        actor: 'EAZEPAY',
        title: 'Audit log middleware',
        whatItDoes:
          'writeAuditLog single helper · ~70 action enum values. Append-only by DB grant (eazepay_app role lacks UPDATE/DELETE on audit_logs).',
        whatItsFor: 'SOC 2 CC7.3 + FCRA evidence.',
        appearsIn: ['Flow 07 · Real-time (7.5)', 'Flow 12 · Tracking (12.1)'],
      },
      {
        index: '5.7',
        actor: 'SYSTEM',
        title: 'Composite rate-limit middleware',
        whatItDoes:
          'Per-route rate-limit factory. Builds keys from multiple sources (user + IP + custom), atomically increments via Redis MULTI pipeline. Fails OPEN on Redis error post 2026-05-24 incident.',
        whatItsFor: 'Login + sensitive-route throttle.',
        appearsIn: ['Flow 02 · Verify', 'Flow 08 · Surfacing'],
      },
      {
        index: '5.8',
        actor: 'SYSTEM',
        title: 'Webhook-signature middleware',
        whatItDoes:
          'Generic HMAC-verify pipeline for MiCamp + Pixie. EazePay App + HighSale have their own inline verify because of payload-shape differences.',
        whatItsFor: 'Inbound signature gate.',
        appearsIn: ['Flow 02 · Verify'],
      },
      {
        index: '5.9',
        actor: 'SYSTEM',
        title: 'Bearer-auth + CSRF middleware',
        whatItDoes: 'PAT verification + double-submit CSRF on cookie auth state-changing routes.',
        whatItsFor: 'Auth gate variants.',
      },
      {
        index: '5.10',
        actor: 'SYSTEM',
        title: 'Tenant context helpers',
        whatItDoes:
          'withTenantSession(prisma, {orgId}, fn) sets app.org_id GUC for one Prisma transaction. Used at every drain entry point + every authenticated tenant-scoped write.',
        whatItsFor: 'RLS context.',
        appearsIn: ['Flow 06 · RLS'],
      },
      {
        index: '5.11',
        actor: 'SYSTEM',
        title: 'WS publisher + WS gateway',
        whatItDoes:
          'publishWsEvent(orgId, event) wraps in tenant envelope. Gateway filters per-connection via shouldDeliverToClient(client, envelope). Investor-scope clients get scopeForInvestor(event) applied.',
        whatItsFor: 'Real-time fan-out.',
        appearsIn: ['Flow 07 · Real-time'],
      },
      {
        index: '5.12',
        actor: 'SYSTEM',
        title: 'Outbound webhook delivery worker',
        whatItDoes:
          'BullMQ worker. Dequeues a delivery, signs with subscriber secret, POSTs with exponential backoff. Final fail → marks outbound_webhook_deliveries.status = ABANDONED + logs with stable errorId.',
        whatItsFor: 'Customer-configured event delivery.',
        appearsIn: ['Flow 07 · Real-time (7.4)'],
      },
    ],
  },
  {
    index: 'B6',
    title: 'External integrations',
    blurb: 'Third-party services. We do NOT own these.',
    cards: [
      {
        index: '6.1',
        actor: 'EXTERNAL',
        title: 'EazePay App platform',
        whatItDoes:
          'Source-of-truth for application-lifecycle events. Posts to our /integration/eazepay-app/events endpoint.',
        whatItsFor: 'Application state ingestion.',
        appearsIn: ['Flow 01 · Inbound (1.1)'],
      },
      {
        index: '6.2',
        actor: 'EXTERNAL',
        title: 'HighSale (EZ Check)',
        whatItDoes:
          'Credit-data orchestration. Pulls Experian/Equifax/TransUnion, normalises, posts the snapshot to our endpoint.',
        whatItsFor: 'Credit enrichment.',
        appearsIn: ['Flow 01 · Inbound (1.2)'],
      },
      {
        index: '6.3',
        actor: 'EXTERNAL',
        title: 'MiCamp',
        whatItDoes:
          'Card processing. Webhook-back on every successful processing event + reversal.',
        whatItsFor: 'Processing fee + reversal tracking.',
        appearsIn: ['Flow 01 · Inbound (1.3)'],
      },
      {
        index: '6.4',
        actor: 'EXTERNAL',
        title: 'Pixie',
        whatItDoes: 'Pre-qualification API. Usage events post-back to our metering endpoint.',
        whatItsFor: 'Pre-qual usage metering.',
        appearsIn: ['Flow 01 · Inbound (1.4)'],
      },
      {
        index: '6.5',
        actor: 'EXTERNAL',
        title: 'Lender reporting APIs',
        whatItDoes:
          "Lenders that don't push events — we poll their reporting API every 15 min and normalise. Per-lender adapter in apps/api/src/domains/lenders/adapter/.",
        whatItsFor: 'Post-funding outcome tracking.',
        appearsIn: ['Flow 01 · Inbound (1.5)'],
      },
      {
        index: '6.6',
        actor: 'EXTERNAL',
        title: 'AWS KMS',
        whatItDoes:
          'Root key for the per-org DEK envelope. AWS encrypts/decrypts the wrapped DEK; we never see the root key plaintext.',
        whatItsFor: 'Crypto trust anchor.',
        appearsIn: ['Flow 05 · Encrypt (5.2)'],
      },
      {
        index: '6.7',
        actor: 'EXTERNAL',
        title: 'AWS S3',
        whatItDoes:
          'Export storage in production. Presigned URLs for download. Local-disk fallback in dev (and currently in degraded prod).',
        whatItsFor: 'Persistent export artifacts.',
        appearsIn: ['Flow 09 · Operator actions (9.2)'],
      },
      {
        index: '6.8',
        actor: 'EXTERNAL',
        title: 'Google OAuth',
        whatItDoes:
          'SSO provider. PKCE flow, JWKS-signed id_token verification, alg pinned to RS256.',
        whatItsFor: 'SSO sign-in.',
      },
      {
        index: '6.9',
        actor: 'EXTERNAL',
        title: 'Railway hosting',
        whatItDoes:
          '5 services: web, api, intel (worker fleet), Redis, Postgres (with timescaledb extension + postgres-volume for the WAL).',
        whatItsFor: 'Platform-as-a-service.',
      },
      {
        index: '6.10',
        actor: 'EXTERNAL',
        title: 'Resend / Twilio',
        whatItDoes:
          'Outcome email (Resend) + outcome SMS (Twilio) dispatched by the notification orchestrator.',
        whatItsFor: 'Operator alert + scheduled-report delivery.',
      },
    ],
  },
  {
    index: 'B7',
    title: 'Data model · DB tables',
    blurb: 'Every domain table. PostgreSQL with TimescaleDB hypertables for time-series.',
    cards: [
      {
        index: '7.1',
        actor: 'EAZEPAY',
        title: 'webhook_events',
        whatItDoes:
          'Source-of-truth for every inbound vendor event. Unique on (org_id, source, idempotency_key). Raw payload column purged after 90 days by lifecycle worker.',
        whatItsFor: 'Idempotency + drain queue.',
        appearsIn: ['Flow 02 · Verify (2.6)'],
        tables: [
          {
            name: 'webhook_events',
            description:
              'id · org_id · source · event_type · idempotency_key · signature_valid · payload',
          },
        ],
      },
      {
        index: '7.2',
        actor: 'EAZEPAY',
        title: 'applications',
        whatItDoes:
          'One row per application lifecycle. PENDING → SUBMITTED → IN_REVIEW → APPROVED → DECLINED → FUNDED. PII columns encrypted via per-org DEK; hash columns for lookup.',
        whatItsFor: 'Application domain table.',
        appearsIn: ['Flow 04 · Drain (4.2)', 'Flow 08 · Surfacing'],
      },
      {
        index: '7.3',
        actor: 'EAZEPAY',
        title: 'partners',
        whatItDoes:
          'One row per merchant partner. external_id for vendor cross-reference. Industry, brand, status, commercial terms.',
        whatItsFor: 'Partner directory.',
      },
      {
        index: '7.4',
        actor: 'EAZEPAY',
        title: 'lender_decisions + lender_reporting_events',
        whatItDoes:
          'Per-lender decision rows + post-funding reporting events (settled, paid, defaulted, hardship).',
        whatItsFor: 'Lender ops + customer timeline.',
      },
      {
        index: '7.5',
        actor: 'EAZEPAY',
        title: 'revenue_events · THE LEDGER',
        whatItDoes:
          'Append-only ledger of every dollar movement. TimescaleDB hypertable, partitioned by effective_at. Stream enum: ORIGINATION, PROCESSING, COMMISSION, REPAYMENT, REVERSAL. eazepay_app role has REVOKE on UPDATE+DELETE — true immutability enforced at DB layer.',
        whatItsFor: 'Source of truth for revenue.',
        appearsIn: ['Flow 04 · Drain', 'Flow 10 · Lifecycle'],
      },
      {
        index: '7.6',
        actor: 'EAZEPAY',
        title: 'revenue_aggregations',
        whatItDoes:
          'Pre-rolled-up per-partner per-month totals. Materialised by aggregation.worker.ts from the ledger.',
        whatItsFor: 'Fast dashboard reads.',
      },
      {
        index: '7.7',
        actor: 'EAZEPAY',
        title: 'credit_enrichments',
        whatItDoes:
          'HighSale snapshot landings. Wide table — every field HighSale emits (score, grades, lookup flags, qualification flags, credit profile, funding estimates, demographics).',
        whatItsFor: 'Credit-profile enrichment.',
      },
      {
        index: '7.8',
        actor: 'EAZEPAY',
        title: 'pixie_metrics + micamp_processing_events + micamp_reversal_events',
        whatItDoes:
          'Vendor-event raw tables. Pixie metrics is a TimescaleDB hypertable for time-series queries.',
        whatItsFor: 'Vendor-event drilldowns.',
      },
      {
        index: '7.9',
        actor: 'EAZEPAY',
        title: 'users + memberships',
        whatItDoes:
          'Authenticated users + per-org memberships. memberships.role is the per-org role (ADMIN / OPERATOR / VIEWER / INVESTOR) and is the SECURITY-CRITICAL one (post-SEC-014).',
        whatItsFor: 'AuthZ.',
      },
      {
        index: '7.10',
        actor: 'EAZEPAY',
        title: 'organizations',
        whatItDoes:
          'Tenant table. slug is unique URL identifier. default org is the bootstrap org (self-seeded by getBootstrapOrgId post 2026-05-24 incident).',
        whatItsFor: 'Tenant identity.',
      },
      {
        index: '7.11',
        actor: 'EAZEPAY',
        title: 'refresh_tokens',
        whatItDoes:
          'Refresh-token family. Rotation on every refresh; reuse detection triggers family revoke. Token storage = HMAC-keyed hash.',
        whatItsFor: 'Long-lived session.',
      },
      {
        index: '7.12',
        actor: 'EAZEPAY',
        title: 'api_tokens',
        whatItDoes:
          'PAT storage. prefix is the lookup key; hashed_secret is the constant-time-compare value. Per-token scopes, expiry, last_used_at.',
        whatItsFor: 'Programmatic auth.',
      },
      {
        index: '7.13',
        actor: 'EAZEPAY',
        title: 'audit_logs',
        whatItDoes:
          'Compliance-grade append-only trail. Every actor action. PII-free metadata by contract. SOC 2 CC7.3 evidence. REVOKE UPDATE/DELETE for eazepay_app role.',
        whatItsFor: 'Compliance + forensics.',
        appearsIn: ['Flow 12 · Tracking'],
      },
      {
        index: '7.14',
        actor: 'EAZEPAY',
        title: 'outbox_events',
        whatItDoes:
          'Transactional outbox for cross-system writes. PENDING → SENT → DLQ states. Sweeper picks up pending rows.',
        whatItsFor: 'Cross-system write durability.',
        appearsIn: ['Flow 04 · Drain'],
      },
      {
        index: '7.15',
        actor: 'EAZEPAY',
        title: 'outbound_webhook_subscriptions + deliveries',
        whatItDoes:
          'Customer-configured webhook destinations. Subscriptions filter by event-type. Deliveries are per-attempt rows.',
        whatItsFor: 'Customer event fan-out.',
      },
      {
        index: '7.16',
        actor: 'EAZEPAY',
        title: 'tenant_encryption_keys',
        whatItDoes:
          'Per-org DEK material (KMS-wrapped). One active row per org. Rotation produces a new active row + leaves old rows for backward-decrypt.',
        whatItsFor: 'Encryption keys.',
        appearsIn: ['Flow 05 · Encrypt (5.1)'],
      },
      {
        index: '7.17',
        actor: 'EAZEPAY',
        title: 'webhook_credentials',
        whatItDoes: 'Per-tenant webhook secret rotation (deferred SEC-005 implementation target).',
        whatItsFor: 'Future home of per-tenant signing secrets.',
      },
      {
        index: '7.18',
        actor: 'EAZEPAY',
        title: 'eazepay_app_quarantine',
        whatItDoes:
          "EazePay App events whose brand body field doesn't map to any org. Operator triages via /platform/quarantine.",
        whatItsFor: 'Brand-mismatch event triage.',
        appearsIn: ['Flow 03 · Quarantine (3.1)'],
      },
      {
        index: '7.19',
        actor: 'EAZEPAY',
        title: 'exports + scheduled_reports + alert_rules + alerts + rtbf_requests',
        whatItDoes:
          'Operator-action tables. Exports + scheduled report config + alert rules + fired alerts + RTBF requests.',
        whatItsFor: 'Write-side state.',
      },
      {
        index: '7.20',
        actor: 'EAZEPAY',
        title: 'notes + tags + user_invitations + notification_channels',
        whatItDoes:
          'Cross-cutting state: operator annotations, tags, invitation tokens, alert/report channels.',
        whatItsFor: 'Cross-domain support.',
      },
    ],
  },
  {
    index: 'B8',
    title: 'Multi-tenant isolation',
    blurb: 'How one Postgres + Redis + Fastify process serves N tenants without leakage.',
    cards: [
      {
        index: '8.1',
        actor: 'SYSTEM',
        title: 'RLS at the DB role',
        whatItDoes:
          'Runtime connects as eazepay_app NOBYPASSRLS. Every query is subject to the policies.',
        whatItsFor: 'Database-layer tenant boundary.',
        appearsIn: ['Flow 06 · RLS'],
      },
      {
        index: '8.2',
        actor: 'SYSTEM',
        title: 'app.org_id GUC',
        whatItDoes:
          "SET LOCAL app.org_id = '<uuid>' at the start of every tenant-scoped transaction. RLS policies read this via current_setting('app.org_id', TRUE).",
        whatItsFor: 'Per-transaction tenant context.',
      },
      {
        index: '8.3',
        actor: 'SYSTEM',
        title: 'app.platform_staff bypass GUC',
        whatItDoes:
          "Set to 'true' for cross-tenant platform-staff routes. Every bypass writes a PLATFORM_CROSS_TENANT_ACCESS audit row so the bypass is never silent.",
        whatItsFor: 'Audited cross-tenant ops.',
      },
      {
        index: '8.4',
        actor: 'SYSTEM',
        title: 'Application-layer orgId predicates',
        whatItDoes:
          'Every Prisma where: { ..., orgId } + every raw-SQL WHERE org_id = $1. Belt-and-braces with RLS.',
        whatItsFor: 'App-layer tenant boundary.',
      },
      {
        index: '8.5',
        actor: 'SYSTEM',
        title: 'WS per-tenant envelope filter',
        whatItDoes:
          'publishWsEvent(orgId, event) envelope; shouldDeliverToClient(client, envelope) per-client filter.',
        whatItsFor: 'Real-time tenant isolation.',
        appearsIn: ['Flow 07 · Real-time'],
      },
      {
        index: '8.6',
        actor: 'SYSTEM',
        title: 'Per-org DEK',
        whatItDoes:
          "Encryption material isolated per org. An exfiltrated DEK only unlocks ONE org's PII. AAD binding (SEC-006 deferred) will additionally make ciphertext non-portable.",
        whatItsFor: 'Encryption tenant boundary.',
      },
      {
        index: '8.7',
        actor: 'SYSTEM',
        title: 'Membership re-check on every request',
        whatItDoes:
          'requireAuth re-verifies memberships(userId, orgId) on every request (skipped for platform staff). A user removed from an org loses access within one request, not within JWT_ACCESS_TTL.',
        whatItsFor: 'Real-time membership enforcement.',
      },
    ],
  },
  {
    index: 'B9',
    title: 'Observability + compliance',
    blurb:
      'Every action leaves a trail. Every metric is bounded. Every secret is provisioned through a documented path.',
    cards: [
      {
        index: '9.1',
        actor: 'EAZEPAY',
        title: 'Audit log',
        whatItDoes:
          'Compliance-grade trail. ~70 action types. PII-free by contract. Immutable at the DB role.',
        whatItsFor: 'SOC 2 + FCRA evidence.',
        appearsIn: ['Flow 12 · Tracking (12.1)'],
      },
      {
        index: '9.2',
        actor: 'EAZEPAY',
        title: 'Alert engine',
        whatItDoes: 'Self-service ops monitoring. Rule-driven. Auto-resolve.',
        whatItsFor: 'Pager-page for on-call.',
        appearsIn: ['Flow 12 · Tracking (12.2)'],
      },
      {
        index: '9.3',
        actor: 'SYSTEM',
        title: 'Metrics endpoint',
        whatItDoes: 'Prometheus scrape target. Bearer-token-gated.',
        whatItsFor: 'External observability stack integration.',
      },
      {
        index: '9.4',
        actor: 'SYSTEM',
        title: 'Slow-query log',
        whatItDoes: "Prisma $on('query') warns at DATABASE_SLOW_QUERY_LOG_MS threshold.",
        whatItsFor: 'Hot-spot identification.',
      },
      {
        index: '9.5',
        actor: 'EAZEPAY',
        title: 'RTBF cryptoshred',
        whatItDoes:
          'GDPR Art. 17 + APP 12/13 compliance. Cryptographically irrecoverable PII deletion while preserving financial/regulatory trail.',
        whatItsFor: 'Right-to-be-forgotten compliance.',
        appearsIn: ['Flow 09 · Operator actions (9.4)'],
      },
      {
        index: '9.6',
        actor: 'EAZEPAY',
        title: 'SOC 2 mapping',
        whatItDoes:
          'Codebase calls out SOC 2 controls inline at every relevant boundary. CC6.1 (logical access — RLS + RBAC), CC6.6 (idempotency-key enforcement), CC7.2 (slow-query monitoring), CC7.3 (audit log immutability), CC8.1 (change management).',
        whatItsFor: 'Audit-trail-by-design.',
      },
      {
        index: '9.7',
        actor: 'EAZEPAY',
        title: 'Retention runbook',
        whatItDoes:
          'Per-data-class retention policy + scrub schedule. Webhook payloads 90d, refresh tokens 7d, audit logs 7y, ledger 7y.',
        whatItsFor: 'Operational compliance.',
      },
    ],
  },
];
