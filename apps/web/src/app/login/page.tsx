'use client';

/**
 * /login — primary sign-in surface.
 *
 * The first thing a lender sees during demo. Tone target: calm,
 * deliberate, regulated-grade. Layout: brand hero on the left (≥ lg)
 * + form card on the right. On narrow viewports the hero hides and
 * the form card centers on the paper background.
 *
 * Shared primitives:
 *   - `BrandMark`        — wordmark above the form (+ inline variant in hero)
 *   - `AuthField`        — labelled input wrapper
 *   - `MfaCodeInput`     — segmented 6-digit code field
 *   - `AuthError`        — calm, role=alert error banner
 *   - `TrustLine`        — SOC 2 / AES-256 / TLS 1.3 marker below form
 *   - `motion-page-in`   — gentle 200ms fade + 4px translate on mount
 *
 * Voice (Sprint D): sentence case, no exclamation, no "please".
 *   - Heading       : "Sign in"
 *   - Sub-copy      : "Continue to EazePay Intelligence."
 *   - CTA           : "Sign in" → "Signing in…"
 *   - Generic error : "Couldn't verify those credentials. Try again."
 *
 * The form deliberately uses raw `useState` (not React Hook Form) to
 * keep the bundle small on this entry surface; the schema is trivial
 * (email + password + optional 6 digits) and the server is
 * authoritative. Submit is disabled while in-flight to prevent
 * double-submit.
 */
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SessionResponse } from '@/lib/types';
import {
  AUTH_INPUT_CLASS,
  AUTH_PRIMARY_BUTTON_CLASS,
  AuthError,
  AuthField,
  BrandMark,
  MfaCodeInput,
  TrustLine,
} from '@/components/auth';

interface OAuthProviders {
  google: boolean;
}

// Map server-side OAuth failure codes to calm, specific user-facing
// messages. Generic codes default to a "try again" line — never a stack
// trace, never blame on the user.
const OAUTH_ERRORS: Record<string, string> = {
  'no-account':
    "No EazePay account is linked to that Google address. Ask an admin to invite you first.",
  'domain-not-allowed': "That Google account is outside your organisation's allowed domains.",
  cancelled: 'Sign-in was cancelled.',
};

const GENERIC_LOGIN_ERROR = "Couldn't verify those credentials. Try again.";

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
  const params = useSearchParams();
  const { setSession } = useAuth();
  const [email, setEmail] = useState('admin@eazepay.local');
  const [password, setPassword] = useState('Demo!1234');
  const [mfa, setMfa] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showMfa, setShowMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<OAuthProviders>({ google: false });

  useEffect(() => {
    const oauthError = params?.get('oauth');
    if (oauthError && OAUTH_ERRORS[oauthError]) setError(OAUTH_ERRORS[oauthError]);
    api<OAuthProviders>('/auth/oauth/providers')
      .then(setProviders)
      .catch(() => setProviders({ google: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apiBase =
    typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL
      ? process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, '')
      : '';

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
      // Server message is authoritative when present (e.g. MFA-required
      // prompts come back with a specific message); otherwise show the
      // calm generic line.
      if (err instanceof ApiError && err.message) {
        setError(err.message);
      } else {
        setError(GENERIC_LOGIN_ERROR);
      }
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
      {/* ─── Left: brand hero (≥ lg) ────────────────────────────────────── */}
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
          <BrandMark variant="inline" />
        </div>

        <div className="relative z-10 max-w-md">
          <h1 className="text-[32px] leading-[1.15] font-semibold tracking-tight">
            The data warehouse for every business in the EazePay group.
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

      {/* ─── Right: form card ──────────────────────────────────────────── */}
      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-[400px] motion-page-in">
          <div className="lg:hidden mb-8">
            <BrandMark variant="stacked" />
          </div>

          <div className="bg-surface border border-line rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] px-7 py-8 sm:px-8 sm:py-9">
            <h2 className="text-ink text-[26px] font-semibold tracking-tight">Sign in</h2>
            <p className="text-muted text-sm mt-1.5">Continue to EazePay Intelligence.</p>

            <form onSubmit={submit} className="mt-7 space-y-5" noValidate>
              <AuthField label="Email">
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@eazepay.local"
                  className={AUTH_INPUT_CLASS}
                />
              </AuthField>

              <AuthField
                label="Password"
                right={
                  <button
                    type="button"
                    className="text-[11px] text-muted hover:text-accent transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded"
                    aria-label="Recover your password"
                  >
                    Forgot?
                  </button>
                }
              >
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className={`${AUTH_INPUT_CLASS} pr-11`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-soft hover:text-ink2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded"
                    tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </AuthField>

              {showMfa ? (
                <div>
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-[12px] font-medium text-ink2 tracking-tight">
                      Verification code
                    </span>
                    <span className="text-[11px] text-soft">6 digits</span>
                  </div>
                  <MfaCodeInput
                    value={mfa}
                    onChange={setMfa}
                    autoFocus
                    ariaLabel="Verification code, six digits"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowMfa(true)}
                  className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-accent transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded"
                >
                  <ShieldCheck size={13} aria-hidden="true" /> I have a verification code
                </button>
              )}

              {error && <AuthError message={error} />}

              <button type="submit" disabled={busy} className={AUTH_PRIMARY_BUTTON_CLASS}>
                {busy ? (
                  'Signing in…'
                ) : (
                  <>
                    Sign in{' '}
                    <ArrowRight
                      size={16}
                      aria-hidden="true"
                      className="opacity-70 group-hover:translate-x-0.5 transition-transform"
                    />
                  </>
                )}
              </button>
            </form>

            {providers.google && (
              <>
                <div className="mt-6 flex items-center gap-3 text-[11px] text-soft">
                  <span className="flex-1 h-px bg-line" aria-hidden="true" />
                  <span>or</span>
                  <span className="flex-1 h-px bg-line" aria-hidden="true" />
                </div>
                <a
                  href={`${apiBase}/api/v1/auth/oauth/google/start`}
                  className="mt-4 w-full h-11 rounded-lg border border-line bg-surface text-ink hover:border-ink2 hover:bg-paper transition flex items-center justify-center gap-3 font-medium text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                  <GoogleMark />
                  Continue with Google
                </a>
              </>
            )}

            {/* Demo account quick-select — internal-only; safe to keep
                visible because this build ships to the demo environment. */}
            <div className="mt-9 pt-6 border-t border-line2">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] uppercase tracking-[0.14em] text-soft font-medium">
                  Quick switch · demo
                </span>
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
                      aria-pressed={active}
                      className={`text-left rounded-lg border px-3 py-2.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
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

          <TrustLine className="mt-6" />
        </div>
      </main>
    </div>
  );
}

function GoogleMark(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
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
