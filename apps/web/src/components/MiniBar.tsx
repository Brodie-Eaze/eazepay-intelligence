'use client';

interface Props {
  /** 0..1 */
  value: number;
  className?: string;
  tone?: 'accent' | 'success' | 'warn' | 'danger';
}

const TONE = {
  accent: 'bg-accent',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
} as const;

export function MiniBar({ value, className, tone = 'accent' }: Props): JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={`bar-track ${className ?? ''}`}>
      <div className={`bar-fill ${TONE[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
