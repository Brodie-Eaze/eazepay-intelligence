'use client';

/**
 * Accept-invitation landing page.
 *
 * URL: /accept-invitation?token=<base64url>
 *
 * Flow:
 *   1. Read token from query string.
 *   2. Preview the invitation (no auth) to show email/role.
 *   3. User picks a password, submits.
 *   4. API atomically creates the User, marks invite consumed, returns a
 *      session — same cookies as /auth/login. Land at /overview.
 *
 * The page renders distinct states (loading, invalid, valid, submitting,
 * error) so the user always knows where they are. No silent failure.
 */
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SessionResponse } from '@/lib/types';

interface Preview {
  email: string;
  role: string;
  expiresAt: string;
}

export default function AcceptInvitationPage(): JSX.Element {
  const params = useSearchParams();
  const router = useRouter();
  const { setSession } = useAuth();
  const token = params?.get('token') ?? '';

  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadError('This link is missing its invitation token.');
      return;
    }
    api<Preview>(`/auth/invitations/${encodeURIComponent(token)}`)
      .then(setPreview)
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.message : 'Invitation is invalid or expired'),
      );
  }, [token]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitError(null);
    if (password !== confirm) {
      setSubmitError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setSubmitError('Password must be at least 8 characters');
      return;
    }
    setBusy(true);
    try {
      const session = await api<SessionResponse>(
        `/auth/invitations/${encodeURIComponent(token)}/accept`,
        { method: 'POST', body: JSON.stringify({ password }) },
      );
      setSession(session);
      router.replace('/overview');
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to accept invitation');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 text-center">
          <div className="font-semibold tracking-tight text-ink text-2xl">EazePay</div>
          <div className="text-accent text-[11px] font-semibold tracking-[0.18em] mt-1">
            INTELLIGENCE
          </div>
        </div>

        {loadError ? (
          <div className="rounded-lg border border-danger/30 bg-dangerSoft px-4 py-3 text-sm text-danger">
            <div className="font-medium">Invitation unavailable</div>
            <div className="mt-1 text-[13px]">{loadError}</div>
            <button
              onClick={() => router.push('/login')}
              className="mt-3 text-[12px] underline hover:no-underline"
            >
              Go to sign-in
            </button>
          </div>
        ) : !preview ? (
          <div className="text-center text-muted text-sm">Loading invitation…</div>
        ) : (
          <>
            <h2 className="text-ink text-[28px] font-semibold tracking-tight">Set your password</h2>
            <p className="text-muted text-sm mt-1.5">
              You&apos;ve been invited as{' '}
              <span className="text-ink font-medium">{preview.role}</span> ·{' '}
              <span className="text-ink2">{preview.email}</span>
            </p>

            <form onSubmit={submit} className="mt-8 space-y-5">
              <Field label="Password">
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="at least 8 characters"
                  className="w-full bg-surface border border-line rounded-lg px-4 h-11 text-[15px] text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accentSoft transition"
                  autoFocus
                />
              </Field>
              <Field label="Confirm password">
                <input
                  type="password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full bg-surface border border-line rounded-lg px-4 h-11 text-[15px] text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accentSoft transition"
                />
              </Field>

              {submitError && (
                <div className="text-[13px] text-danger bg-dangerSoft px-3 py-2 rounded-lg">
                  {submitError}
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full h-11 rounded-lg bg-ink text-surface font-medium tracking-tight text-[15px] hover:bg-ink2 disabled:opacity-50 transition flex items-center justify-center gap-2 group"
              >
                {busy ? (
                  'Creating account…'
                ) : (
                  <>
                    Accept &amp; sign in{' '}
                    <ArrowRight
                      size={16}
                      className="opacity-70 group-hover:translate-x-0.5 transition-transform"
                    />
                  </>
                )}
              </button>
            </form>

            <div className="mt-8 pt-5 border-t border-line2 flex items-start gap-2.5 text-[11px] text-muted">
              <ShieldCheck size={13} className="mt-0.5 text-accent" />
              <span>
                Pick a password you don&apos;t use anywhere else. You can enable two-factor
                authentication after signing in.
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-ink2 tracking-tight mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
