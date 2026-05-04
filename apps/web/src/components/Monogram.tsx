'use client';

interface Props {
  label: string;  // partner name OR anonymized code
  className?: string;
}

/** Two-letter monogram square — derived from label. */
export function Monogram({ label, className }: Props): JSX.Element {
  const letters = label
    .replace(/^PARTNER-/, 'P')
    .split(/\s+|-/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '··';
  return <span className={`mono ${className ?? ''}`}>{letters}</span>;
}
