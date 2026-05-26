/**
 * MfaCodeInput — six segmented inputs for a 6-digit MFA / TOTP code.
 *
 * Why segmented instead of one input:
 *   - Visually communicates the expected shape (6 digits) before the
 *     user types — fewer questions, fewer fat-finger mistakes.
 *   - Auto-advance between segments feels like the platform is helping
 *     the user, not making them work.
 *   - Paste of a full code populates every segment in one go.
 *
 * Controlled component: parent owns the string. Component normalises
 * to digits and clamps to 6 chars. Calls `onComplete` once the code
 * reaches length 6 (lets the parent auto-submit if desired).
 *
 * A11y:
 *   - Each input has an `aria-label="Digit N of 6"` so screen readers
 *     orient correctly.
 *   - Backspace on an empty cell focuses the previous cell.
 *   - Arrow keys navigate between cells.
 *   - `inputMode="numeric"` + `autoComplete="one-time-code"` triggers
 *     the OS-level SMS autofill on iOS / Android.
 *
 * Monospace font + wide letter-spacing applied per-cell.
 */
'use client';

import { useEffect, useRef, type ClipboardEvent, type JSX, type KeyboardEvent } from 'react';

const LENGTH = 6;

interface MfaCodeInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired when the value reaches `LENGTH` digits. */
  onComplete?: (code: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Accessible label for the group (e.g. "MFA code"). */
  ariaLabel?: string;
}

export function MfaCodeInput({
  value,
  onChange,
  onComplete,
  autoFocus = false,
  disabled = false,
  ariaLabel = 'Six-digit verification code',
}: MfaCodeInputProps): JSX.Element {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  // Auto-focus first cell on mount.
  useEffect(() => {
    if (autoFocus && refs.current[0]) refs.current[0].focus();
  }, [autoFocus]);

  // Fire onComplete when full.
  useEffect(() => {
    if (value.length === LENGTH && onComplete) onComplete(value);
  }, [value, onComplete]);

  const focusCell = (idx: number): void => {
    const target = refs.current[Math.min(LENGTH - 1, Math.max(0, idx))];
    if (target) target.focus();
  };

  const setDigitAt = (idx: number, digit: string): void => {
    const chars = value.padEnd(LENGTH, ' ').split('');
    chars[idx] = digit;
    const next = chars.join('').replace(/\s+$/g, '').slice(0, LENGTH);
    onChange(next);
  };

  const handleChange = (idx: number, raw: string): void => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 0) {
      setDigitAt(idx, '');
      return;
    }
    if (digits.length === 1) {
      setDigitAt(idx, digits);
      if (idx < LENGTH - 1) focusCell(idx + 1);
      return;
    }
    // Multi-char paste pasted into a single cell — distribute starting here.
    const merged = (value.slice(0, idx) + digits).slice(0, LENGTH);
    onChange(merged);
    focusCell(Math.min(LENGTH - 1, merged.length));
  };

  const handleKeyDown = (idx: number, e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace') {
      if (!value[idx] && idx > 0) {
        e.preventDefault();
        setDigitAt(idx - 1, '');
        focusCell(idx - 1);
      }
      return;
    }
    if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault();
      focusCell(idx - 1);
    }
    if (e.key === 'ArrowRight' && idx < LENGTH - 1) {
      e.preventDefault();
      focusCell(idx + 1);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, LENGTH);
    if (!pasted) return;
    e.preventDefault();
    onChange(pasted);
    focusCell(Math.min(LENGTH - 1, pasted.length));
  };

  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center justify-between gap-2">
      {Array.from({ length: LENGTH }, (_, i) => {
        const char = value[i] ?? '';
        return (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={1}
            value={char}
            disabled={disabled}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
            onFocus={(e) => e.target.select()}
            aria-label={`Digit ${i + 1} of ${LENGTH}`}
            className={
              'w-11 h-12 bg-surface border border-line rounded-lg text-center ' +
              'font-mono text-[20px] text-ink tabular-nums ' +
              'outline-none transition ' +
              'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface ' +
              'disabled:opacity-50 disabled:cursor-not-allowed'
            }
          />
        );
      })}
    </div>
  );
}
