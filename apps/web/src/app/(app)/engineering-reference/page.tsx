/**
 * Engineering reference page for Eaze Intelligence (authenticated).
 *
 * Mirrors the EazePay platform reference design — left sidebar nav,
 * numbered cards for every flow step + reference surface. Content
 * source: `apps/web/src/lib/engineering-reference-data.ts` (mirrored
 * from `docs/ENGINEERING_REFERENCE.md` in the repo root).
 *
 * SSR auth gate (council Finding 2, 2026-05-26): this page lives in the
 * `(app)` route group but the group's layout only does a CLIENT-SIDE
 * redirect — a direct HTTP GET would SSR the full platform topology to
 * anonymous requesters before client JS loaded. We now verify the
 * `epi_access` cookie against `/auth/me` server-side and `redirect()`
 * BEFORE returning JSX. TODO(SF-???): hoist this into a Next middleware
 * covering the entire `(app)` group so every page is protected at the
 * edge instead of opting in individually.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import type {
  Actor,
  CardKind,
  Endpoint,
  FlowPhase,
  FlowStep,
  ReferenceCard,
  ReferenceSection,
  SurfaceTag,
  TableRef,
} from '@/lib/engineering-reference-data';
import { FLOW, REFERENCE } from '@/lib/engineering-reference-data';

export const metadata: Metadata = {
  title: 'Eaze Intelligence · engineering reference + data flow',
  description:
    'Everything in the Eaze Intelligence platform — flow + surface-by-surface reference in one doc.',
};

// ─── helpers ────────────────────────────────────────────────────────────────

function actorColor(actor: Actor): string {
  switch (actor) {
    case 'OPERATOR':
      return 'bg-indigo-50 text-indigo-700 ring-indigo-200';
    case 'EAZEPAY':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
    case 'VENDOR':
      return 'bg-violet-50 text-violet-700 ring-violet-200';
    case 'LENDER':
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    case 'EXTERNAL':
      return 'bg-rose-50 text-rose-700 ring-rose-200';
    case 'SYSTEM':
    default:
      return 'bg-slate-100 text-slate-700 ring-slate-200';
  }
}

function tagColor(kind: CardKind): string {
  switch (kind) {
    case 'HTTP':
      return 'bg-slate-900 text-white';
    case 'SYSTEM':
      return 'bg-slate-100 text-slate-700 ring-slate-200';
    case 'DATA':
      return 'bg-blue-50 text-blue-700 ring-blue-200';
    case 'EXTERNAL':
      return 'bg-rose-50 text-rose-700 ring-rose-200';
    case 'NOTIFY':
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    case 'WORKER':
      return 'bg-violet-50 text-violet-700 ring-violet-200';
    case 'PAGE':
      return 'bg-indigo-50 text-indigo-700 ring-indigo-200';
    default:
      return 'bg-slate-100 text-slate-700 ring-slate-200';
  }
}

function methodColor(method: Endpoint['method']): string {
  switch (method) {
    case 'GET':
      return 'bg-emerald-600 text-white';
    case 'POST':
      return 'bg-indigo-600 text-white';
    case 'PATCH':
      return 'bg-amber-600 text-white';
    case 'DELETE':
      return 'bg-rose-600 text-white';
    default:
      return 'bg-slate-600 text-white';
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ─── primitives ─────────────────────────────────────────────────────────────

function ActorBadge({ actor }: { actor: Actor }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider ring-1 ring-inset ${actorColor(actor)}`}
    >
      {actor}
    </span>
  );
}

function TagBadge({ tag }: { tag: SurfaceTag }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider ring-1 ring-inset ${tagColor(tag.kind)}`}
      >
        {tag.kind}
      </span>
      <div className="text-sm">
        <span className="font-medium text-slate-900">{tag.label}</span>
        {tag.sub && <span className="text-slate-500 ml-2">{tag.sub}</span>}
      </div>
    </div>
  );
}

function EndpointRow({ endpoint }: { endpoint: Endpoint }): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span
        className={`inline-block w-14 text-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${methodColor(endpoint.method)}`}
      >
        {endpoint.method}
      </span>
      <code className="font-mono text-xs text-slate-800">{endpoint.path}</code>
      {endpoint.note && <span className="text-xs text-slate-500">· {endpoint.note}</span>}
    </div>
  );
}

function TableRow({ t }: { t: TableRef }): JSX.Element {
  return (
    <div className="py-1.5">
      <code className="font-mono text-xs font-semibold text-slate-900">{t.name}</code>
      <div className="text-xs text-slate-600">{t.description}</div>
    </div>
  );
}

// ─── flow step ──────────────────────────────────────────────────────────────

function StepCard({ step }: { step: FlowStep }): JSX.Element {
  return (
    <div className="border border-slate-200 rounded-xl p-6 bg-white">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs font-mono text-slate-400">{step.index}</span>
        <ActorBadge actor={step.actor} />
      </div>
      <h3 className="text-lg font-semibold text-slate-900 mb-2 tracking-tight">{step.title}</h3>
      <p className="text-sm text-slate-600 leading-relaxed">{step.description}</p>

      {step.tags && step.tags.length > 0 && (
        <div className="mt-4 space-y-2">
          {step.tags.map((tag, i) => (
            <TagBadge key={i} tag={tag} />
          ))}
        </div>
      )}

      {step.endpoints && step.endpoints.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
            HTTP Endpoints
          </div>
          {step.endpoints.map((e, i) => (
            <EndpointRow key={i} endpoint={e} />
          ))}
        </div>
      )}

      {step.tables && step.tables.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
            Database Tables
          </div>
          {step.tables.map((t, i) => (
            <TableRow key={i} t={t} />
          ))}
        </div>
      )}

      {step.code && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          {step.code.title && (
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              {step.code.title}
            </div>
          )}
          <pre className="bg-slate-900 text-slate-100 text-[12px] leading-relaxed p-4 rounded-lg overflow-x-auto font-mono">
            {step.code.body}
          </pre>
        </div>
      )}
    </div>
  );
}

function PhaseSection({ phase }: { phase: FlowPhase }): JSX.Element {
  const phaseId = `flow-${phase.index}-${slugify(phase.title)}`;
  return (
    <section id={phaseId} className="scroll-mt-12">
      <div className="flex items-start gap-4 mb-4">
        <span className="inline-flex items-center justify-center min-w-[2.5rem] h-10 rounded-lg bg-slate-900 text-white text-sm font-mono">
          {String(phase.index).padStart(2, '0')}
        </span>
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">{phase.title}</h2>
          <p className="text-sm text-slate-600 mt-1 leading-relaxed">{phase.blurb}</p>
        </div>
      </div>

      <div className="space-y-4 mt-6">
        {phase.steps.map((step) => (
          <StepCard key={step.index} step={step} />
        ))}
      </div>
    </section>
  );
}

// ─── reference surface ─────────────────────────────────────────────────────

function SurfaceCard({ card }: { card: ReferenceCard }): JSX.Element {
  return (
    <div className="border border-slate-200 rounded-xl p-6 bg-white">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs font-mono text-slate-400">{card.index}</span>
        <ActorBadge actor={card.actor} />
      </div>
      <h3 className="text-lg font-semibold text-slate-900 mb-3 tracking-tight">{card.title}</h3>

      <div className="space-y-2">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            What it does:
          </span>
          <p className="text-sm text-slate-600 leading-relaxed mt-0.5">{card.whatItDoes}</p>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            What it&apos;s for:
          </span>
          <p className="text-sm text-slate-600 leading-relaxed mt-0.5">{card.whatItsFor}</p>
        </div>
      </div>

      {card.tags && card.tags.length > 0 && (
        <div className="mt-4 space-y-2">
          {card.tags.map((tag, i) => (
            <TagBadge key={i} tag={tag} />
          ))}
        </div>
      )}

      {card.appearsIn && card.appearsIn.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
            Appears in flow:
          </div>
          <div className="flex flex-wrap gap-1.5">
            {card.appearsIn.map((flow, i) => (
              <span
                key={i}
                className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-slate-50 text-slate-700 ring-1 ring-slate-200"
              >
                {flow}
              </span>
            ))}
          </div>
        </div>
      )}

      {card.endpoints && card.endpoints.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
            HTTP Endpoints
          </div>
          {card.endpoints.map((e, i) => (
            <EndpointRow key={i} endpoint={e} />
          ))}
        </div>
      )}

      {card.tables && card.tables.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
            Database Tables
          </div>
          {card.tables.map((t, i) => (
            <TableRow key={i} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReferenceSectionBlock({ section }: { section: ReferenceSection }): JSX.Element {
  const sectionId = `ref-${section.index.toLowerCase()}-${slugify(section.title)}`;
  return (
    <section id={sectionId} className="scroll-mt-12">
      <div className="flex items-start gap-4 mb-4">
        <span className="inline-flex items-center justify-center min-w-[2.5rem] h-10 rounded-lg bg-slate-900 text-white text-sm font-mono">
          {section.index}
        </span>
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">{section.title}</h2>
          <p className="text-sm text-slate-600 mt-1 leading-relaxed">{section.blurb}</p>
        </div>
      </div>

      <div className="space-y-4 mt-6">
        {section.cards.map((card) => (
          <SurfaceCard key={card.index} card={card} />
        ))}
      </div>
    </section>
  );
}

// ─── sidebar nav ────────────────────────────────────────────────────────────

function Sidebar(): JSX.Element {
  return (
    <aside className="w-72 shrink-0 sticky top-0 self-start h-screen overflow-y-auto py-8 px-6 border-r border-slate-200 bg-white">
      <div className="mb-8">
        <h1 className="text-base font-bold text-slate-900 tracking-tight">Eaze Intelligence</h1>
        <p className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">
          Flow + reference · v1
        </p>
      </div>

      <div className="space-y-6">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-3">
            A · Data Flow
          </div>
          <nav className="space-y-1">
            {FLOW.map((phase) => (
              <div key={phase.index}>
                <a
                  href={`#flow-${phase.index}-${slugify(phase.title)}`}
                  className="flex items-start gap-2 text-xs text-slate-700 hover:text-slate-900 py-1"
                >
                  <span className="text-slate-400 font-mono">
                    {String(phase.index).padStart(2, '0')}
                  </span>
                  <span className="font-medium">{phase.title}</span>
                </a>
              </div>
            ))}
          </nav>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-3">
            B · Reference
          </div>
          <nav className="space-y-1">
            {REFERENCE.map((section) => (
              <a
                key={section.index}
                href={`#ref-${section.index.toLowerCase()}-${slugify(section.title)}`}
                className="flex items-start gap-2 text-xs text-slate-700 hover:text-slate-900 py-1"
              >
                <span className="text-slate-400 font-mono">{section.index}</span>
                <span className="font-medium">{section.title}</span>
              </a>
            ))}
          </nav>
        </div>
      </div>
    </aside>
  );
}

// ─── stats ──────────────────────────────────────────────────────────────────

function StatsRow(): JSX.Element {
  const flowSteps = FLOW.reduce((n, p) => n + p.steps.length, 0);
  const refSurfaces = REFERENCE.reduce((n, s) => n + s.cards.length, 0);
  return (
    <div className="mt-10 grid grid-cols-4 gap-x-8 gap-y-4 py-8 border-y border-slate-200">
      <div>
        <div className="text-4xl font-semibold text-slate-900 tracking-tight">{FLOW.length}</div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-1 font-semibold">
          Flow phases
        </div>
      </div>
      <div>
        <div className="text-4xl font-semibold text-slate-900 tracking-tight">{flowSteps}</div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-1 font-semibold">
          Flow steps
        </div>
      </div>
      <div>
        <div className="text-4xl font-semibold text-slate-900 tracking-tight">
          {REFERENCE.length}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-1 font-semibold">
          Reference parts
        </div>
      </div>
      <div>
        <div className="text-4xl font-semibold text-slate-900 tracking-tight">{refSurfaces}</div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-1 font-semibold">
          Surfaces documented
        </div>
      </div>
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

async function requireServerSession(): Promise<void> {
  // Server-side gate. Read the access cookie and validate against the API's
  // /auth/me — if absent or invalid, redirect to /login before any JSX is
  // rendered. The client-side AppShell redirect runs AFTER SSR, which is
  // too late: the HTML body would already contain the platform topology.
  const access = cookies().get('epi_access')?.value;
  if (!access) redirect('/login');
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3010';
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/v1/auth/me`, {
      headers: { cookie: `epi_access=${access}` },
      cache: 'no-store',
    });
  } catch {
    // Fail closed — if the API is unreachable we cannot prove the caller is
    // authenticated, so we redirect rather than SSR the platform docs.
    redirect('/login');
  }
  if (!res.ok) redirect('/login');
}

export default async function EngineeringReferencePage(): Promise<JSX.Element> {
  await requireServerSession();
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased">
      <div className="flex">
        <Sidebar />

        <main className="flex-1 max-w-4xl mx-auto px-10 py-12">
          {/* Header */}
          <div className="mb-2">
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-slate-900 text-white text-[10px] font-semibold tracking-wider">
              ● ENGINEERING REFERENCE + DATA FLOW
            </span>
          </div>

          <h1 className="text-5xl font-bold text-slate-900 tracking-tight leading-[1.1] mt-6">
            Everything in the Eaze Intelligence platform — in one doc.
          </h1>

          <p className="text-base text-slate-600 leading-relaxed mt-6 max-w-3xl">
            <strong className="text-slate-900">Part A</strong> walks the data flow end-to-end
            (vendor webhook → normalised row → operator dashboard).{' '}
            <strong className="text-slate-900">Part B</strong> is the surface-by-surface reference
            for every page, system, integration, and DB table. Every Reference card links to the
            Flow phase(s) it appears in.
          </p>

          <StatsRow />

          {/* Part A banner */}
          <div className="mt-12 rounded-2xl bg-slate-900 text-white p-8">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
              Part A
            </div>
            <h2 className="text-3xl font-bold tracking-tight mt-2">Data Flow</h2>
            <p className="text-sm text-slate-300 mt-3 leading-relaxed max-w-2xl">
              Every phase of the data journey, in the order it actually happens. From a
              vendor&apos;s HTTP POST to an operator&apos;s dashboard pixel.
            </p>
          </div>

          {/* Part A */}
          <div className="space-y-16 mt-12">
            {FLOW.map((phase) => (
              <PhaseSection key={phase.index} phase={phase} />
            ))}
          </div>

          {/* Part B banner */}
          <div className="mt-16 rounded-2xl bg-slate-900 text-white p-8">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
              Part B
            </div>
            <h2 className="text-3xl font-bold tracking-tight mt-2">Platform Reference</h2>
            <p className="text-sm text-slate-300 mt-3 leading-relaxed max-w-2xl">
              Every surface, system, integration, and DB table explained on its own terms. Use this
              when you need to understand a specific page or table in isolation.
            </p>
          </div>

          {/* Part B */}
          <div className="space-y-16 mt-12">
            {REFERENCE.map((section) => (
              <ReferenceSectionBlock key={section.index} section={section} />
            ))}
          </div>

          {/* Footer */}
          <div className="mt-20 pt-8 border-t border-slate-200 text-sm text-slate-600 space-y-2">
            <div>
              <strong className="text-slate-900">Repo:</strong>{' '}
              <a
                href="https://github.com/Brodie-Eaze/eazepay-intelligence"
                className="text-indigo-700 hover:underline"
              >
                github.com/Brodie-Eaze/eazepay-intelligence
              </a>
            </div>
            <div>
              <strong className="text-slate-900">Source:</strong>{' '}
              <code className="font-mono text-xs">docs/ENGINEERING_REFERENCE.md</code> +{' '}
              <code className="font-mono text-xs">
                apps/web/src/lib/engineering-reference-data.ts
              </code>
            </div>
            <div className="text-xs text-slate-500 mt-4">
              Format-matched to the EazePay platform engineering reference. Generated 2026-05-24.
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
