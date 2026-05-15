'use client';

/**
 * Lightweight confirm dialog component to replace native `window.confirm()`.
 *
 * Why this exists (Phase H reviewer fix): native `confirm()` ships
 * unstyled and breaks the platform's design language. For SOC 2 / CTO
 * review surfaces (the /platform/quarantine triage page especially)
 * a branded modal is appearance-relevant.
 *
 * Minimal API: render the trigger button + this dialog; call open() to
 * show it; user picks Confirm or Cancel; the callback fires.
 */
import { ReactNode, useState } from 'react';

interface Props {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  trigger: (open: () => void) => ReactNode;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  trigger,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      {trigger(() => setOpen(true))}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="confirm-dialog-title" className="text-base font-semibold text-zinc-900">
              {title}
            </h3>
            <div className="mt-2 text-sm text-zinc-600">{body}</div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
                onClick={() => setOpen(false)}
                type="button"
              >
                {cancelLabel}
              </button>
              <button
                className={`rounded px-3 py-1.5 text-sm font-medium ${
                  danger
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'bg-zinc-900 text-white hover:bg-zinc-800'
                }`}
                onClick={() => {
                  setOpen(false);
                  onConfirm();
                }}
                type="button"
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
