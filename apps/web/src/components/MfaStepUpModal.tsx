'use client';

/**
 * MfaStepUpModal — shared component that prompts the user for a TOTP
 * code and POSTs to /auth/mfa/step-up/verify. On success the server
 * sets the __Host-mfa_stepup cookie; the dashboard then re-tries the
 * destructive action that triggered the prompt.
 *
 * Usage pattern: every page with a SUPER-action button wraps the
 * mutation in `runWithMfaStepUp(action)`. If the action throws
 * ApiError{code: 'MFA_STEP_UP_REQUIRED'}, the helper opens this modal,
 * waits for verification, then retries the original action once.
 *
 * Design notes:
 *   - The modal is controlled — render it at the top of the page and
 *     pass an open/close state. The default `useMfaStepUp()` hook below
 *     wires this for callers that want it self-contained.
 *   - No "remember me / skip MFA next time" option. Every SUPER action
 *     prompts fresh.
 *   - 6-digit TOTP input only (matches authenticator app format).
 *   - On verify error, surface the message but don't close the modal —
 *     user can re-try with a fresh code.
 */
import { useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';

interface VerifyResponse {
  token: string;
  expiresAt: string;
}

interface Props {
  open: boolean;
  onSuccess: () => void;
  onClose: () => void;
}

export function MfaStepUpModal({ open, onSuccess, onClose }: Props): JSX.Element | null {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async (): Promise<void> => {
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<VerifyResponse>('/auth/mfa/step-up/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setCode('');
      onSuccess();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Couldn’t verify the code. Try again.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mfa-stepup-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="mfa-stepup-title" className="text-base font-semibold text-zinc-900">
          MFA required
        </h3>
        <p className="mt-2 text-sm text-zinc-600">
          This action needs a fresh MFA proof. Enter the 6-digit code from your authenticator app.
        </p>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          pattern="\d{6}"
          placeholder="123 456"
          className="mt-4 w-full rounded border border-zinc-300 px-3 py-2 font-mono text-lg tracking-widest"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void verify();
          }}
          disabled={busy}
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            onClick={() => void verify()}
            disabled={busy || code.length !== 6}
          >
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </div>
        <p className="mt-4 text-xs text-zinc-500">
          Valid for 5 minutes, single-use. The action retries automatically.
        </p>
      </div>
    </div>
  );
}

/**
 * Hook helper. Returns:
 *   - `withMfaStepUp(action)` — runs `action`. If it throws
 *     ApiError(MFA_STEP_UP_REQUIRED), opens the modal, waits, retries
 *     `action` once. Surfaces other errors normally.
 *   - `modalProps` — pass to <MfaStepUpModal {...modalProps} />
 */
export function useMfaStepUp(): {
  withMfaStepUp: <T>(action: () => Promise<T>) => Promise<T>;
  modalProps: Props;
} {
  const [pendingAction, setPendingAction] = useState<{
    run: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  } | null>(null);

  const withMfaStepUp = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_STEP_UP_REQUIRED') {
        return new Promise<T>((resolve, reject) => {
          setPendingAction({
            run: action as () => Promise<unknown>,
            resolve: resolve as (v: unknown) => void,
            reject,
          });
        });
      }
      throw err;
    }
  }, []);

  const modalProps: Props = {
    open: pendingAction !== null,
    onClose: () => {
      pendingAction?.reject(new Error('MFA step-up cancelled'));
      setPendingAction(null);
    },
    onSuccess: () => {
      const p = pendingAction;
      setPendingAction(null);
      if (!p) return;
      p.run().then(p.resolve, p.reject);
    },
  };

  return { withMfaStepUp, modalProps };
}
