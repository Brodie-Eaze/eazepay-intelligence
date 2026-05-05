'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SessionResponse } from '@/lib/types';

interface DemoAccount {
  email: string;
  role: string;
  description: string;
}
const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: 'admin@eazepay.local',
    role: 'Admin',
    description: 'Full access · users · audit · pricing',
  },
  {
    email: 'operator@eazepay.local',
    role: 'Operator',
    description: 'Read PII · onboard partners · all data',
  },
  { email: 'viewer@eazepay.local', role: 'Viewer', description: 'Read-only · masked PII' },
  { email: 'investor@eazepay.local', role: 'Investor', description: 'Aggregated views only' },
];

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const { setSession } = useAuth();
  const [email, setEmail] = useState('admin@eazepay.local');
  const [password, setPassword] = useState('Demo!1234');
  const [mfa, setMfa] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showMfa, setShowMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const trimmedMfa = mfa.trim();
      const validMfa = /^\d{6}$/.test(trimmedMfa) ? trimmedMfa : undefined;
      const session = await api<SessionResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, ...(validMfa ? { mfaCode: validMfa } : {}) }),
      });
      setSession(session);
      router.replace('/overview');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const fillDemo = (acct: DemoAccount): void => {
    setEmail(acct.email);
    setPassword('Demo!1234');
    setError(null);
  };

  return (
    <div className="min-h-screen bg-paper flex">
      {/* ─── Left: brand hero ───────────────────────────────────────────── */}
      <aside className="hidden lg:flex flex-col justify-between w-[44%] p-12 bg-hero text-surface relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(700px 360px at 100% 0%, rgba(59,130,246,0.20), transparent 60%),' +
              'radial-gradient(900px 500px at 0% 100%, rgba(147,197,253,0.10), transparent 60%)',
          }}
        />
        <div className="relative z-10">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold tracking-tight text-2xl">EazePay</span>
            <span className="text-accent text-[11px] font-semibold tracking-[0.18em]">
              INTELLIGENCE
            </span>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <h1 className="text-[32px] leading-[1.15] font-semibold tracking-tight">
            The financial intelligence layer for the EazePay platform.
          </h1>
          <p className="mt-4 text-surface/55 text-[15px] leading-relaxed">
            One pane of glass over the customer book and the economics. Credit profile, risk band,
            propensity vs outcome, every lender decision, every dollar funded and clawed back —
            searchable, drillable, reconciling to a signed-webhook ledger.
          </p>
        </div>

        <div className="relative z-10 grid grid-cols-3 gap-6 max-w-md">
          <Stat n="600" label="applications" />
          <Stat n="$24k" label="largest funded deal" />
          <Stat n="100%" label="audit coverage" />
        </div>
      </aside>

      {/* ─── Right: form ───────────────────────────────────────────────── */}
      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-[400px]">
          <div className="lg:hidden mb-8 text-center">
            <div className="font-semibold tracking-tight text-ink text-2xl">EazePay</div>
            <div className="text-accent text-[11px] font-semibold tracking-[0.18em] mt-1">
              INTELLIGENCE
            </div>
          </div>

          <h2 className="text-ink text-[28px] font-semibold tracking-tight">Welcome back</h2>
          <p className="text-muted text-sm mt-1.5">Sign in to continue to the dashboard.</p>

          <form onSubmit={submit} className="mt-8 space-y-5">
            <Field label="Email">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@eazepay.local"
                className="w-full bg-surface border border-line rounded-lg px-4 h-11 text-[15px] text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accentSoft transition"
              />
            </Field>

            <Field
              label="Password"
              right={
                <button
                  type="button"
                  className="text-[11px] text-muted hover:text-accent transition"
                >
                  Forgot?
                </button>
              }
            >
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-surface border border-line rounded-lg pl-4 pr-11 h-11 text-[15px] text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accentSoft transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-soft hover:text-ink2 transition"
                  tabIndex={-1}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>

            {showMfa ? (
              <Field label="MFA code">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={mfa}
                  onChange={(e) => setMfa(e.target.value.replace(/\D/g, ''))}
                  placeholder="123 456"
                  className="w-full bg-surface border border-line rounded-lg px-4 h-11 text-[15px] text-ink tracking-[0.4em] text-center outline-none focus:border-accent focus:ring-4 focus:ring-accentSoft transition"
                  autoFocus
                />
              </Field>
            ) : (
              <button
                type="button"
                onClick={() => setShowMfa(true)}
                className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-accent transition"
              >
                <ShieldCheck size={13} /> I have an MFA code
              </button>
            )}

            {error && (
              <div className="text-[13px] text-danger bg-dangerSoft px-3 py-2 rounded-lg">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full h-11 rounded-lg bg-ink text-surface font-medium tracking-tight text-[15px] hover:bg-ink2 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2 group"
            >
              {busy ? (
                'Signing in…'
              ) : (
                <>
                  Sign in{' '}
                  <ArrowRight
                    size={16}
                    className="opacity-70 group-hover:translate-x-0.5 transition-transform"
                  />
                </>
              )}
            </button>
          </form>

          {/* Demo account quick-select */}
          <div className="mt-10 pt-6 border-t border-line2">
            <div className="flex items-baseline justify-between">
              <span className="h-section">Quick switch · demo</span>
              <span className="text-[11px] text-soft">password preserved</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((acct) => {
                const active = email === acct.email;
                return (
                  <button
                    key={acct.email}
                    type="button"
                    onClick={() => fillDemo(acct)}
                    className={`text-left rounded-lg border px-3 py-2.5 transition ${
                      active
                        ? 'border-ink bg-ink text-surface'
                        : 'border-line hover:border-ink2 hover:bg-paper text-ink2'
                    }`}
                  >
                    <div
                      className={`text-[13px] font-medium tracking-tight ${active ? 'text-surface' : 'text-ink'}`}
                    >
                      {acct.role}
                    </div>
                    <div
                      className={`text-[11px] mt-0.5 truncate ${active ? 'text-surface/60' : 'text-muted'}`}
                    >
                      {acct.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] font-medium text-ink2 tracking-tight">{label}</span>
        {right}
      </div>
      {children}
    </label>
  );
}

function Stat({ n, label }: { n: string; label: string }): JSX.Element {
  return (
    <div>
      <div className="numeric text-[22px] font-semibold tracking-tight text-surface">{n}</div>
      <div className="text-[11px] text-surface/45 mt-0.5">{label}</div>
    </div>
  );
}
