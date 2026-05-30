/**
 * Public landing page for the Eaze Intelligence platform.
 *
 * Marketing-grade explainer that sits next to the deep-dive
 * /engineering-reference page. This route is intentionally outside the
 * (app) auth group so it can be hit without a session — a lender or
 * investor can pull it up in a meeting.
 *
 * Every claim on this page is grounded in the actual codebase:
 *   - 13 BullMQ workers          → apps/api/src/workers/*.worker.ts
 *   - TimescaleDB hypertables    → apps/api/prisma/init-timescale.sql
 *   - 14 PII redact path globs   → apps/api/src/config/logger.ts
 *   - 12 flow phases             → apps/web/src/lib/engineering-reference-data.ts
 *   - tenant RLS, outbox, JWT    → docs/ENGINEERING_REFERENCE.md
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { FLOW } from '@/lib/engineering-reference-data';
import { ScrollProgress } from '@/components/ui/ScrollProgress';
import { AnchorLink } from '@/components/ui/AnchorLink';
import { PlatformSidebar } from './_components/PlatformSidebar';

export const metadata: Metadata = {
  title: 'Eaze Intelligence · the operator command center for EazePay',
  description:
    'A multi-tenant data warehouse, intelligence layer, and reconciliation engine that sits on top of EazePay — one view of every application, revenue event, webhook, and customer across the portfolio.',
};

const DASHBOARD_URL = 'https://eaze-intelligence.up.railway.app';
const REPO_URL = 'https://github.com/Brodie-Eaze/eazepay-intelligence';

// ─── data (grounded in the codebase) ────────────────────────────────────────

const WORKERS: ReadonlyArray<{ name: string; purpose: string }> = [
  { name: 'webhook', purpose: 'normalise inbound vendor events into the domain model' },
  { name: 'webhook-delivery', purpose: 'sign + retry outbound HMAC webhooks with DLQ' },
  { name: 'outbox', purpose: 'transactional outbox sweeper for cross-system writes' },
  { name: 'export', purpose: 'CSV / JSON exports with cryptographic integrity envelope' },
  { name: 'aggregation', purpose: 'roll revenue events into hypertable continuous aggregates' },
  { name: 'lifecycle', purpose: 'application + customer state transitions' },
  { name: 'alert', purpose: 'evaluate alert rules, fan out to channels' },
  { name: 'scheduled-report', purpose: 'cron-driven report runs (CFO weekly, etc.)' },
  { name: 'lender-polling', purpose: 'pull-based ingestion for lenders without webhooks' },
  { name: 'pii-reencryption', purpose: 'rotate per-org DEKs, re-wrap consumer PII' },
  { name: 'correlation-linker', purpose: 'stitch app / CRM / settlement records together' },
  { name: 'revenue', purpose: 'derive revenue_events from raw vendor payloads' },
  { name: 'retention', purpose: 'GDPR / APP scrub + redact on policy expiry' },
];

const INTEGRATIONS: ReadonlyArray<{ name: string; purpose: string }> = [
  { name: 'MiCamp', purpose: 'payment processing (ISO partner) — settlement + chargeback feed' },
  { name: 'HighSale', purpose: 'consumer-financing CRM — credit data + lender waterfall' },
  { name: 'EazePay App', purpose: 'consumer-facing app — application-lifecycle webhooks' },
  { name: 'Pixie', purpose: 'analytics + attribution — usage metering' },
  { name: 'Lender panel', purpose: 'multi-lender waterfall mediated by HighSale' },
];

const ROLES: ReadonlyArray<{ role: string; uses: string }> = [
  {
    role: 'CFO / Finance Controller',
    uses: 'revenue recognition, TTM / MRR, settlement reconciliation, board pack',
  },
  {
    role: 'Settlements Ops',
    uses: 'daily settlement close, MiCamp variance investigation, break drill-through',
  },
  {
    role: 'Lender Relations Manager',
    uses: 'waterfall performance, conversion economics, per-lender funded volume',
  },
  {
    role: 'Merchant Relations / Account Manager',
    uses: 'merchant book, churn risk band, escalation queue',
  },
  {
    role: 'Risk / Underwriting',
    uses: 'credit decisioning audit trail, model performance, fair-lending evidence',
  },
  {
    role: 'Compliance / BSA Officer',
    uses: 'SAR / CTR queries, OFAC screening evidence, immutable audit log',
  },
  {
    role: 'Operations Manager',
    uses: 'DLQ health, integration uptime, webhook reliability, quarantine triage',
  },
  {
    role: 'CEO / Founder',
    uses: 'holdco rollup across MedPay, TradePay, CoachPay and every other brand',
  },
  {
    role: 'Customer Support',
    uses: 'consumer history, payment status, dispute lookup with PII unmask audit',
  },
  {
    role: 'External Investor (read-only scope)',
    uses: 'board-pack KPIs scoped to non-PII aggregates, no consumer detail',
  },
];

const OUTCOMES: ReadonlyArray<{ question: string; answer: string }> = [
  {
    question: 'Where is revenue today?',
    answer: 'Live KPI cards, 90-day chart, real-time WebSocket push as events land.',
  },
  {
    question: 'Which customers are delinquent?',
    answer: 'Filtered customer book with risk-band taxonomy and last-paid age.',
  },
  {
    question: 'Which webhooks are failing?',
    answer: 'DLQ surface with replay + acknowledge, grouped by integration + error class.',
  },
  {
    question: 'Run a SAR / CTR query for this quarter?',
    answer: 'Scoped audit export with cryptographic integrity envelope and signed manifest.',
  },
  {
    question: 'Reconcile MiCamp settlement vs ledger?',
    answer: 'Side-by-side variance with drill-through to the underlying revenue_events.',
  },
  {
    question: 'What is the TTM per business in the portfolio?',
    answer: 'Holdco rollup with per-brand split — MedPay, TradePay, CoachPay, etc.',
  },
  {
    question: 'Which lender converted best last month?',
    answer: 'Lender waterfall analytics — funded ratio, decline reasons, time-to-decision.',
  },
];

const INSIDE: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Multi-tenant Postgres with row-level security',
    body: 'A runtime DB role with policies on every tenant table. Every query is org-scoped at the database layer; the app cannot leak across tenants even if a route forgets to filter.',
  },
  {
    title: 'TimescaleDB hypertables for revenue_events',
    body: 'revenue_events on a 30-day chunk interval; pixie_metrics and revenue_aggregations on 7-day chunks. Continuous aggregates power the operator KPI cards.',
  },
  {
    title: 'Redis + BullMQ worker fleet — 13 workers',
    body: 'Each worker is idempotent, retried with exponential backoff, and DLQ-aware. Failures are surfaced in the platform quarantine UI for operator triage.',
  },
  {
    title: 'WebSocket gateway with per-tenant filtering',
    body: 'Real-time push for application events, alerts, DLQ activity. Tickets are issued at the API and validated on connect — channels are org-scoped by construction.',
  },
  {
    title: 'Outbox pattern for cross-system writes',
    body: 'Domain writes and emitted events land in the same transaction. The outbox worker drains to Redis pub/sub, outbound webhooks, and the analytics stream.',
  },
  {
    title: 'AES-256-GCM envelope encryption per-org DEKs',
    body: 'Per-tenant data encryption keys wrapped by a KMS-backed master key. PII is encrypted on write; indexable fields are stored as keyed hashes alongside the ciphertext.',
  },
  {
    title: 'JWT-kind-pinned auth with refresh-token family revocation',
    body: 'Access and refresh tokens carry a kind claim and cannot be swapped. A leaked refresh token rotates the whole family, killing every descendant.',
  },
  {
    title: 'HMAC-signed webhooks both directions',
    body: 'Inbound from EazePay App, HighSale, MiCamp, and Pixie — verified with timestamp tolerance and two-layer dedup (Redis SETNX → DB unique). Outbound is signed and replayable from the delivery worker.',
  },
  {
    title: 'Audit log immutability via DB role grants',
    body: 'The runtime role has REVOKE UPDATE / DELETE on audit_log. Even a compromised API process cannot rewrite history.',
  },
];

// ─── primitives ─────────────────────────────────────────────────────────────

function NumberChip({ n }: { n: string }): JSX.Element {
  return (
    <span className="inline-flex items-center justify-center min-w-[2.5rem] h-10 rounded-lg bg-ink text-white text-sm font-mono">
      {n}
    </span>
  );
}

interface SectionProps {
  id: string;
  numeral: string;
  title: string;
  blurb?: string;
  children: React.ReactNode;
}

function Section({ id, numeral, title, blurb, children }: SectionProps): JSX.Element {
  return (
    <section
      id={id}
      className="scroll-mt-12 border-t border-line2 pt-16 first:border-t-0 first:pt-0"
    >
      <div className="flex items-start gap-4 mb-4">
        <NumberChip n={numeral} />
        <div className="flex-1">
          <div className="flex items-start gap-2">
            <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">{title}</h2>
            <AnchorLink targetId={id} className="mt-1.5" />
          </div>
          {blurb && <p className="text-sm text-slate-600 mt-1 leading-relaxed">{blurb}</p>}
        </div>
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="border border-line rounded-2xl p-6 bg-white">
      <h3 className="text-sm font-semibold text-slate-900 tracking-tight">{title}</h3>
      <div className="text-sm text-slate-600 leading-relaxed mt-2">{children}</div>
    </div>
  );
}

// ─── data flow diagram (inline SVG, no decorative gradients) ───────────────

function FlowDiagram(): JSX.Element {
  // 6 stages laid out left-to-right, hairline-only.
  const stages = [
    'Vendor webhook',
    'Verify + dedup',
    'Outbox',
    'Worker fleet',
    'Domain tables',
    'Operator + WS push',
  ];
  const w = 960;
  const h = 140;
  const padX = 20;
  const boxW = (w - padX * 2 - (stages.length - 1) * 16) / stages.length;
  const boxH = 56;
  const y = (h - boxH) / 2;
  return (
    <div className="border border-line rounded-2xl bg-white p-6 overflow-x-auto">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="Data flow: vendor webhook through verification, outbox, worker fleet, domain tables, and on to operator with WebSocket push."
        className="w-full h-auto min-w-[640px]"
      >
        {stages.map((label, i) => {
          const x = padX + i * (boxW + 16);
          return (
            <g key={label}>
              <rect
                x={x}
                y={y}
                width={boxW}
                height={boxH}
                rx={10}
                fill="#FFFFFF"
                stroke="#E2E8F0"
                strokeWidth={1}
              />
              <text
                x={x + boxW / 2}
                y={y + boxH / 2 + 4}
                textAnchor="middle"
                fontFamily="Inter, sans-serif"
                fontSize={12}
                fontWeight={600}
                fill="#0F172A"
              >
                {label}
              </text>
              {i < stages.length - 1 && (
                <g>
                  <line
                    x1={x + boxW}
                    y1={y + boxH / 2}
                    x2={x + boxW + 16}
                    y2={y + boxH / 2}
                    stroke="#94A3B8"
                    strokeWidth={1}
                  />
                  <polygon
                    points={`${x + boxW + 16},${y + boxH / 2} ${x + boxW + 12},${y + boxH / 2 - 3} ${x + boxW + 12},${y + boxH / 2 + 3}`}
                    fill="#94A3B8"
                  />
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-slate-600 mt-3 leading-relaxed">
        Every inbound event is HMAC-verified, idempotency-checked twice (Redis SETNX then DB unique
        constraint), written to the outbox in the same transaction, drained by a worker into the
        typed domain model, and pushed to operators over a per-tenant WebSocket channel — in that
        order, every time.
      </p>
    </div>
  );
}

// ─── architecture diagram ──────────────────────────────────────────────────

function ArchDiagram(): JSX.Element {
  return (
    <div className="border border-line rounded-2xl bg-white p-6 overflow-x-auto">
      <svg
        viewBox="0 0 960 320"
        role="img"
        aria-label="Architecture: Edge (Next.js on Cloudflare + Railway) calls API (Fastify + Prisma), which uses Postgres, Redis, and S3. Workers consume from Redis. Observability spans all layers."
        className="w-full h-auto min-w-[640px]"
      >
        {/* Edge */}
        <rect x="20" y="20" width="920" height="56" rx="10" fill="#FFFFFF" stroke="#E2E8F0" />
        <text x="40" y="46" fontFamily="Inter" fontSize="11" fontWeight="700" fill="#475569">
          EDGE
        </text>
        <text x="40" y="62" fontFamily="Inter" fontSize="12" fill="#0F172A">
          Next.js 14 web app · Cloudflare · Railway
        </text>

        {/* API */}
        <rect x="20" y="92" width="600" height="56" rx="10" fill="#FFFFFF" stroke="#E2E8F0" />
        <text x="40" y="118" fontFamily="Inter" fontSize="11" fontWeight="700" fill="#475569">
          API
        </text>
        <text x="40" y="134" fontFamily="Inter" fontSize="12" fill="#0F172A">
          Fastify + Prisma · rate-limited · RLS-enforced · OpenTelemetry
        </text>

        {/* Workers */}
        <rect x="636" y="92" width="304" height="56" rx="10" fill="#0F172A" stroke="#0F172A" />
        <text x="656" y="118" fontFamily="Inter" fontSize="11" fontWeight="700" fill="#94A3B8">
          WORKERS
        </text>
        <text x="656" y="134" fontFamily="Inter" fontSize="12" fill="#FFFFFF">
          13 BullMQ workers · idempotent · DLQ-aware
        </text>

        {/* Storage row */}
        <rect x="20" y="164" width="294" height="56" rx="10" fill="#FFFFFF" stroke="#E2E8F0" />
        <text x="40" y="190" fontFamily="Inter" fontSize="11" fontWeight="700" fill="#475569">
          POSTGRES
        </text>
        <text x="40" y="206" fontFamily="Inter" fontSize="12" fill="#0F172A">
          Multi-tenant · RLS · TimescaleDB
        </text>

        <rect x="333" y="164" width="294" height="56" rx="10" fill="#FFFFFF" stroke="#E2E8F0" />
        <text x="353" y="190" fontFamily="Inter" fontSize="11" fontWeight="700" fill="#475569">
          REDIS
        </text>
        <text x="353" y="206" fontFamily="Inter" fontSize="12" fill="#0F172A">
          Cache · BullMQ queues · WS pubsub
        </text>

        <rect x="646" y="164" width="294" height="56" rx="10" fill="#FFFFFF" stroke="#E2E8F0" />
        <text x="666" y="190" fontFamily="Inter" fontSize="11" fontWeight="700" fill="#475569">
          S3
        </text>
        <text x="666" y="206" fontFamily="Inter" fontSize="12" fill="#0F172A">
          Exports · DEK envelopes
        </text>

        {/* Observability */}
        <rect
          x="20"
          y="236"
          width="920"
          height="56"
          rx="10"
          fill="#FFFFFF"
          stroke="#E2E8F0"
          strokeDasharray="3 3"
        />
        <text x="40" y="262" fontFamily="Inter" fontSize="11" fontWeight="700" fill="#475569">
          OBSERVABILITY
        </text>
        <text x="40" y="278" fontFamily="Inter" fontSize="12" fill="#0F172A">
          Pino structured logs · PII redaction · Prometheus metrics · distributed traces
        </text>

        {/* connectors */}
        <line x1="320" y1="76" x2="320" y2="92" stroke="#94A3B8" />
        <line x1="320" y1="148" x2="320" y2="164" stroke="#94A3B8" />
        <line x1="788" y1="148" x2="788" y2="164" stroke="#94A3B8" />
      </svg>
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

interface NavItem {
  id: string;
  label: string;
  numeral: string;
}

const NAV: ReadonlyArray<NavItem> = [
  { id: 'what-it-is', label: 'What it is', numeral: '01' },
  { id: 'problem', label: 'What it solves', numeral: '02' },
  { id: 'how-it-works', label: 'How it works', numeral: '03' },
  { id: 'inside', label: "What's inside", numeral: '04' },
  { id: 'architecture', label: 'Architecture', numeral: '05' },
  { id: 'outcomes', label: 'Outcomes', numeral: '06' },
  { id: 'roles', label: 'Who uses it', numeral: '07' },
  { id: 'integrations', label: 'Integrations', numeral: '08' },
  { id: 'security', label: 'Security + compliance', numeral: '09' },
  { id: 'more', label: 'Learn more', numeral: '10' },
];

export default function PlatformPage(): JSX.Element {
  const flowPhases = FLOW;
  const buildSha = process.env.NEXT_PUBLIC_BUILD_SHA?.slice(0, 7) ?? 'dev';

  return (
    <div className="min-h-screen bg-paper text-slate-900 antialiased">
      <ScrollProgress />
      <div className="flex">
        <PlatformSidebar items={NAV} buildSha={buildSha} />

        <main className="flex-1 max-w-4xl mx-auto px-6 md:px-10 py-12">
          {/* ── Hero ───────────────────────────────────────────────────── */}
          <header>
            <div>
              <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-ink text-white text-[10px] font-semibold tracking-wider">
                ● EAZE INTELLIGENCE · PLATFORM
              </span>
            </div>

            <h1 className="text-4xl md:text-5xl font-bold text-slate-900 tracking-tight leading-[1.05] mt-6">
              The operator command center for EazePay.
            </h1>

            <p className="text-base md:text-lg text-slate-600 leading-relaxed mt-6 max-w-3xl">
              A multi-tenant data warehouse, intelligence layer, and reconciliation engine that sits
              on top of EazePay&apos;s consumer-financing flow — one view of every application,
              every revenue event, every reconciliation break, every webhook in flight, every
              customer&apos;s history.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href={DASHBOARD_URL}
                className="inline-flex items-center px-5 py-2.5 rounded-lg bg-ink text-white text-sm font-semibold hover:bg-ink2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              >
                Open dashboard →
              </a>
              <Link
                href="/engineering-reference"
                className="inline-flex items-center px-5 py-2.5 rounded-lg bg-white text-slate-900 text-sm font-semibold border border-line hover:bg-line2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              >
                Engineering reference
              </Link>
            </div>

            {/* stat strip */}
            <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-6 py-8 border-y border-line">
              <div>
                <div className="text-3xl md:text-4xl font-semibold text-slate-900 tracking-tight">
                  13
                </div>
                <div className="text-[10px] uppercase tracking-wider text-slate-600 mt-1 font-semibold">
                  BullMQ workers
                </div>
              </div>
              <div>
                <div className="text-3xl md:text-4xl font-semibold text-slate-900 tracking-tight">
                  {flowPhases.length}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-slate-600 mt-1 font-semibold">
                  Flow phases
                </div>
              </div>
              <div>
                <div className="text-3xl md:text-4xl font-semibold text-slate-900 tracking-tight">
                  5
                </div>
                <div className="text-[10px] uppercase tracking-wider text-slate-600 mt-1 font-semibold">
                  Vendor integrations
                </div>
              </div>
              <div>
                <div className="text-3xl md:text-4xl font-semibold text-slate-900 tracking-tight">
                  30d
                </div>
                <div className="text-[10px] uppercase tracking-wider text-slate-600 mt-1 font-semibold">
                  Hypertable chunk
                </div>
              </div>
            </div>
          </header>

          <div className="mt-16 space-y-16">
            {/* ── 01 What it is ─────────────────────────────────────────── */}
            <Section id="what-it-is" numeral="01" title="What it is">
              <p className="text-sm text-slate-600 leading-relaxed max-w-3xl">
                Eaze Intelligence is a multi-tenant data warehouse + intelligence layer +
                reconciliation engine that sits on top of EazePay&apos;s consumer-financing flow —
                BNPL referrals via the lender waterfall, MiCamp ISO processing, and HighSale CRM.
                Operators get a single view of every application, every revenue event, every
                reconciliation break, every webhook in flight, and every customer&apos;s history —
                across every business in the portfolio (MedPay, TradePay, CoachPay, and any future
                brand).
              </p>
            </Section>

            {/* ── 02 Problem ────────────────────────────────────────────── */}
            <Section id="problem" numeral="02" title="What problem it solves">
              <div className="grid md:grid-cols-2 gap-4">
                <Card title="Before">
                  <ul className="space-y-2 list-disc pl-4">
                    <li>
                      Revenue data lived across MiCamp, HighSale, lender portals, spreadsheets.
                    </li>
                    <li>
                      Reconciliation took days; settlement variance went unexplained for weeks.
                    </li>
                    <li>
                      &ldquo;What is our TTM per stream?&rdquo; required pulling four systems by
                      hand.
                    </li>
                    <li>No audit trail you could hand a regulator without a project plan.</li>
                  </ul>
                </Card>
                <Card title="After">
                  <ul className="space-y-2 list-disc pl-4">
                    <li>One platform. Real-time. Multi-tenant. Audit-trail-grade.</li>
                    <li>Settlement variance surfaces the same day MiCamp publishes the file.</li>
                    <li>TTM, MRR, per-stream and holdco rollup are KPI cards, not workflows.</li>
                    <li>SAR / CTR exports run in minutes with a signed integrity envelope.</li>
                  </ul>
                </Card>
              </div>
            </Section>

            {/* ── 03 How it works ───────────────────────────────────────── */}
            <Section
              id="how-it-works"
              numeral="03"
              title="How it works — the data flow"
              blurb="From a vendor's HTTP POST to an operator's dashboard pixel."
            >
              <FlowDiagram />

              <div className="mt-8">
                <div className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold mb-3">
                  The {flowPhases.length} phases
                </div>
                <ol className="border border-line rounded-2xl bg-white divide-y divide-line2">
                  {flowPhases.map((phase) => (
                    <li key={phase.index} className="flex items-start gap-4 p-4">
                      <span className="font-mono text-xs text-slate-400 w-6 shrink-0">
                        {String(phase.index).padStart(2, '0')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-slate-900">{phase.title}</div>
                        {phase.blurb && (
                          <div className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                            {phase.blurb}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="text-xs text-slate-600 mt-3">
                  Want the 60-step deep-dive instead?{' '}
                  <Link
                    href="/engineering-reference"
                    className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
                  >
                    Read the engineering reference →
                  </Link>
                </p>
              </div>
            </Section>

            {/* ── 04 What's inside ──────────────────────────────────────── */}
            <Section
              id="inside"
              numeral="04"
              title="What's inside the platform"
              blurb="The components that ship in every deployment."
            >
              <div className="grid md:grid-cols-2 gap-4">
                {INSIDE.map((item) => (
                  <Card key={item.title} title={item.title}>
                    {item.body}
                  </Card>
                ))}
              </div>

              {/* worker list */}
              <div className="mt-6 border border-line rounded-2xl bg-white p-6">
                <h3 className="text-sm font-semibold text-slate-900 tracking-tight">
                  The 13 workers
                </h3>
                <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 mt-3">
                  {WORKERS.map((w) => (
                    <div key={w.name} className="text-sm flex items-baseline gap-2">
                      <code className="font-mono text-xs text-slate-900 font-semibold whitespace-nowrap">
                        {w.name}
                      </code>
                      <span className="text-slate-600 text-xs leading-snug">— {w.purpose}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Section>

            {/* ── 05 Architecture ───────────────────────────────────────── */}
            <Section id="architecture" numeral="05" title="The architecture">
              <ArchDiagram />

              <div className="grid md:grid-cols-2 gap-4 mt-6">
                <Card title="Edge">
                  Next.js 14 App Router web app, Cloudflare in front, Railway hosting. Static
                  marketing routes (like this one) render at build, dashboards stream from the API.
                </Card>
                <Card title="API">
                  Fastify + Prisma, rate-limited per route, RLS-enforced at the DB session,
                  instrumented with OpenTelemetry. JWT-kind-pinned auth with refresh-token family
                  revocation.
                </Card>
                <Card title="Workers">
                  13 BullMQ workers on shared Redis. Every job is idempotent, retried with
                  exponential backoff, and DLQ-aware. Failed jobs surface in the platform quarantine
                  UI.
                </Card>
                <Card title="Storage">
                  Postgres (primary, multi-tenant, TimescaleDB for time-series), Redis (cache,
                  queues, WebSocket pub/sub), S3 (export artifacts, DEK envelopes).
                </Card>
                <Card title="Observability">
                  Pino structured logs with 14 PII redact path globs (covering consumer name / email
                  / phone, password hashes, MFA secrets, token hashes, refresh + access tokens, and
                  encryption-key env vars). Prometheus metrics. Distributed traces.
                </Card>
                <Card title="Real-time">
                  Per-tenant WebSocket channels. Tickets issued at the API, validated on connect.
                  Outbox writes fan out to WS pub/sub and signed outbound webhooks in the same
                  transaction.
                </Card>
              </div>
            </Section>

            {/* ── 06 Outcomes ───────────────────────────────────────────── */}
            <Section
              id="outcomes"
              numeral="06"
              title="The outcomes"
              blurb="Questions an operator can answer without leaving the platform."
            >
              <div className="border border-line rounded-2xl bg-white divide-y divide-line2">
                {OUTCOMES.map((o) => (
                  <div key={o.question} className="p-5 md:p-6">
                    <div className="text-sm font-semibold text-slate-900">
                      &ldquo;{o.question}&rdquo;
                    </div>
                    <div className="text-sm text-slate-600 mt-1.5 leading-relaxed">{o.answer}</div>
                  </div>
                ))}
              </div>
            </Section>

            {/* ── 07 Who uses it ────────────────────────────────────────── */}
            <Section
              id="roles"
              numeral="07"
              title="Who uses it"
              blurb="The departments and roles inside an ISO / holdco that the platform serves."
            >
              <div className="border border-line rounded-2xl bg-white divide-y divide-line2">
                {ROLES.map((r) => (
                  <div key={r.role} className="p-5 grid md:grid-cols-[16rem_1fr] gap-2 md:gap-6">
                    <div className="text-sm font-semibold text-slate-900">{r.role}</div>
                    <div className="text-sm text-slate-600 leading-relaxed">{r.uses}</div>
                  </div>
                ))}
              </div>
            </Section>

            {/* ── 08 Integrations ───────────────────────────────────────── */}
            <Section id="integrations" numeral="08" title="Integrations">
              <div className="border border-line rounded-2xl bg-white divide-y divide-line2">
                {INTEGRATIONS.map((i) => (
                  <div key={i.name} className="p-5 grid md:grid-cols-[12rem_1fr] gap-2 md:gap-6">
                    <div className="text-sm font-semibold text-slate-900">{i.name}</div>
                    <div className="text-sm text-slate-600 leading-relaxed">{i.purpose}</div>
                  </div>
                ))}
              </div>
            </Section>

            {/* ── 09 Security + compliance ──────────────────────────────── */}
            <Section
              id="security"
              numeral="09"
              title="Security + compliance posture"
              blurb="Calm, factual. What is actually in place today."
            >
              <div className="grid md:grid-cols-2 gap-4">
                <Card title="At rest">
                  AES-256-GCM envelope encryption with per-org DEKs wrapped by a KMS-backed master
                  key. PII is encrypted on write; indexable fields are keyed hashes.
                </Card>
                <Card title="In transit">
                  TLS 1.3 everywhere. HMAC-signed webhooks both inbound and outbound, with timestamp
                  tolerance and two-layer dedup.
                </Card>
                <Card title="Tenancy">
                  Multi-tenant Postgres with row-level security. A runtime DB role with policies on
                  every tenant table — the app cannot leak across tenants even by mistake.
                </Card>
                <Card title="Audit log">
                  Immutability via DB role grants: REVOKE UPDATE / DELETE on audit_log for the
                  runtime role. Cryptographic integrity envelope on every export.
                </Card>
                <Card title="Frameworks">
                  SOC 2 Type II — controls in place, audit window in progress. GDPR Art. 32 and
                  Australian Privacy Principles aligned.
                </Card>
                <Card title="Logging">
                  Pino structured logs with explicit PII redaction (consumer name / email / phone,
                  password hashes, MFA secrets, every token field, encryption-key env vars). Nothing
                  sensitive lands in a log line.
                </Card>
              </div>

              <p className="text-xs text-slate-600 mt-4">
                Live status page:{' '}
                <Link
                  href="/status"
                  className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
                >
                  /status
                </Link>{' '}
                · Security overview:{' '}
                <Link
                  href="/security"
                  className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
                >
                  /security
                </Link>
              </p>
            </Section>

            {/* ── 10 Learn more ─────────────────────────────────────────── */}
            <Section id="more" numeral="10" title="Where to learn more">
              <div className="grid md:grid-cols-2 gap-4">
                <Card title="Engineering reference">
                  The 12-phase, 60-step deep-dive plus a surface-by-surface reference for every
                  page, system, integration, and DB table.{' '}
                  <Link
                    href="/engineering-reference"
                    className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
                  >
                    Read →
                  </Link>
                </Card>
                <Card title="Source code">
                  Mono-repo with apps/web, apps/api, and the worker fleet.{' '}
                  <a
                    href={REPO_URL}
                    className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
                  >
                    GitHub →
                  </a>
                </Card>
                <Card title="Changelog">
                  What shipped, when, and why.{' '}
                  <Link
                    href="/changelog"
                    className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
                  >
                    /changelog →
                  </Link>
                </Card>
                <Card title="Status">
                  Live integration health, worker fleet uptime, queue depth.{' '}
                  <Link
                    href="/status"
                    className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
                  >
                    /status →
                  </Link>
                </Card>
              </div>
            </Section>
          </div>

          {/* ── Footer ─────────────────────────────────────────────────── */}
          <footer className="mt-20 pt-8 border-t border-line text-sm text-slate-600 space-y-2">
            <div>
              <strong className="text-slate-900">Live:</strong>{' '}
              <a
                href={DASHBOARD_URL}
                className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
              >
                eaze-intelligence.up.railway.app
              </a>
            </div>
            <div>
              <strong className="text-slate-900">Repo:</strong>{' '}
              <a
                href={REPO_URL}
                className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
              >
                github.com/Brodie-Eaze/eazepay-intelligence
              </a>
            </div>
            <div className="text-xs text-slate-600 mt-4">
              Built by Brodie. Format-matched to the Eaze Intelligence engineering reference. Build{' '}
              {buildSha}.
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
