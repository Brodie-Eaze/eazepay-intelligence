'use client';

/**
 * /accept-invitation — invitee landing page.
 *
 * URL: /accept-invitation?token=<base64url>
 *
 * Flow
 *   1. Read token from query string.
 *   2. Preview the invitation (no auth) → show email/role/expiry.
 *   3. User picks a password, submits.
 *   4. API atomically creates the User, marks invite consumed, returns
 *      a session (same cookies as /auth/login). Land on /overview.
 *
 * Four distinct surface states — never silent, never blank:
 *   - missing token       (`loadError = 'missing'`)   → calm message + CTA back to /login
 *   - loading preview     (`!preview && !loadError`)  → labelled spinner / skeleton text
 *   - invalid / expired   (`loadError` populated)     → specific server message + CTA back
 *   - valid preview       (`preview` populated)       → password + confirm form
 *
 * The page is brand-locked via `AuthCard` and uses the same focus rings
 * and trust-line as /login so an invitee's first surface looks like the
 * same product they're being invited into. The invitee is told what role
 * they're joining as ("Joining as Admin") — the platform makes the role
 * decision feel intentional, not bureaucratic.
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SessionResponse } from '@/lib/types';
import {
  AUTH_INPUT_CLASS,
  AUTH_PRIMARY_BUTTON_CLASS,
  AuthCard,
  AuthError,
  AuthField,
} from '@/components/auth';

interface Preview {
  email: string;
  role: string;
  expiresAt: string;
}

const PASSWORD_MIN = 8;
const GENERIC_ACCEPT_ERROR = "Couldn't complete sign-up. Try again.";

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
        setLoadError(
          err instanceof ApiError && err.message
            ? err.message
            : 'This invitation is invalid or has expired.',
        ),
      );
  }, [token]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitError(null);
    if (password !== confirm) {
      setSubmitError("Passwords don't match. Try again.");
      return;
    }
    if (password.length < PASSWORD_MIN) {
      setSubmitError(`Password must be at least ${PASSWORD_MIN} characters.`);
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
      setSubmitError(
        err instanceof ApiError && err.message ? err.message : GENERIC_ACCEPT_ERROR,
      );
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      {loadError ? (
        <InvalidInvitationState message={loadError} onBack={() => router.push('/login')} />
      ) : !preview ? (
        <LoadingPreviewState />
      ) : (
        <ValidInvitationForm
          preview={preview}
          password={password}
          confirm={confirm}
          busy={busy}
          submitError={submitError}
          onPassword={setPassword}
          onConfirm={setConfirm}
          onSubmit={submit}
        />
      )}
    </AuthCard>
  );
}

/* ─── States ────────────────────────────────────────────────────────── */

function LoadingPreviewState(): JSX.Element {
  return (
    <div className="py-2" role="status" aria-live="polite">
      <div className="h-6 w-40 bg-line2 rounded animate-pulse" />
      <div className="mt-3 h-4 w-64 bg-line2 rounded animate-pulse" />
      <div className="mt-8 space-y-4">
        <div className="h-11 bg-line2 rounded-lg animate-pulse" />
        <div className="h-11 bg-line2 rounded-lg animate-pulse" />
        <div className="h-11 bg-line2 rounded-lg animate-pulse" />
      </div>
      <span className="sr-only">Loading invitation…</span>
    </div>
  );
}

function InvalidInvitationState({
  message,
  onBack,
}: {
  message: string;
  onBack: () => void;
}): JSX.Element {
  return (
    <div>
      <h2 className="text-ink text-[22px] font-semibold tracking-tight">
        Invitation unavailable
      </h2>
      <p className="text-muted text-sm mt-2">{message}</p>
      <p className="text-soft text-[13px] mt-3">
        Invitations expire after a short window. Ask the admin who invited you to resend.
      </p>
      <button
        type="button"
        onClick={onBack}
        className={`${AUTH_PRIMARY_BUTTON_CLASS} mt-6`}
      >
        Back to sign-in
        <ArrowRight size={16} aria-hidden="true" className="opacity-70" />
      </button>
    </div>
  );
}

function ValidInvitationForm({
  preview,
  password,
  confirm,
  busy,
  submitError,
  onPassword,
  onConfirm,
  onSubmit,
}: {
  preview: Preview;
  password: string;
  confirm: string;
  busy: boolean;
  submitError: string | null;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}): JSX.Element {
  return (
    <>
      {/* Inviting context — the headline gives the invitee a sense of what
          they're joining, not just a transactional "set password" task. */}
      <div className="text-[11px] uppercase tracking-[0.14em] text-accent font-semibold">
        You&apos;re invited
      </div>
      <h2 className="text-ink text-[26px] font-semibold tracking-tight mt-2">
        Joining as {preview.role}
      </h2>
      <p className="text-muted text-sm mt-2">
        Set a password to activate{' '}
        <span className="text-ink font-medium">{preview.email}</span> on EazePay Intelligence.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-5" noValidate>
        <AuthField label="Password">
          <input
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            placeholder={`at least ${PASSWORD_MIN} characters`}
            className={AUTH_INPUT_CLASS}
            minLength={PASSWORD_MIN}
            autoFocus
          />
        </AuthField>
        <AuthField label="Confirm password">
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => onConfirm(e.target.value)}
            className={AUTH_INPUT_CLASS}
            minLength={PASSWORD_MIN}
          />
        </AuthField>

        {submitError && <AuthError message={submitError} />}

        <button type="submit" disabled={busy} className={AUTH_PRIMARY_BUTTON_CLASS}>
          {busy ? (
            'Creating account…'
          ) : (
            <>
              Accept and sign in{' '}
              <ArrowRight
                size={16}
                aria-hidden="true"
                className="opacity-70 group-hover:translate-x-0.5 transition-transform"
              />
            </>
          )}
        </button>
      </form>

      <div className="mt-7 pt-5 border-t border-line2 flex items-start gap-2.5 text-[11px] text-muted">
        <ShieldCheck size={13} aria-hidden="true" className="mt-0.5 text-accent shrink-0" />
        <span>
          Pick a password you don&apos;t use anywhere else. You can enable two-factor
          authentication after signing in.
        </span>
      </div>
    </>
  );
}
