'use client';

import Link from 'next/link';

/**
 * Operational health indicator for the system as a whole. Click-through
 * to /status for the per-service breakdown.
 *
 * TODO: wire to a real /health probe (poll every 30s, debounce flap).
 * For now the variant is fixed at `operational` so the chrome reads
 * truthfully in demo without faking the data path.
 */

export type StatusBadgeVariant = 'operational' | 'degraded' | 'outage';

interface Props {
  variant?: StatusBadgeVariant;
  /** Render without the link wrapper, e.g. when nested in an anchor. */
  asStatic?: boolean;
}

const TONE: Record<StatusBadgeVariant, { dot: string; text: string; label: string; ring: string }> =
  {
    operational: {
      dot: 'bg-emerald-500',
      text: 'text-emerald-700',
      ring: 'hover:bg-emerald-500/10',
      label: 'All systems operational',
    },
    degraded: {
      dot: 'bg-amber-500',
      text: 'text-amber-700',
      ring: 'hover:bg-amber-500/10',
      label: 'Degraded performance',
    },
    outage: {
      dot: 'bg-rose-500',
      text: 'text-rose-700',
      ring: 'hover:bg-rose-500/10',
      label: 'Service disruption',
    },
  };

export function StatusBadge({ variant = 'operational', asStatic }: Props): JSX.Element {
  const tone = TONE[variant];
  const inner = (
    <span
      className={`inline-flex items-center gap-2 px-2 py-1 rounded-md text-[11px] font-medium transition ${tone.text} ${tone.ring}`}
    >
      <span className="relative inline-flex w-1.5 h-1.5">
        <span
          className={`absolute inset-0 rounded-full ${tone.dot} ${variant === 'operational' ? 'animate-ping opacity-60' : ''}`}
        />
        <span className={`relative inline-block w-1.5 h-1.5 rounded-full ${tone.dot}`} />
      </span>
      <span className="truncate">{tone.label}</span>
    </span>
  );

  if (asStatic) return inner;

  return (
    <Link href="/status" aria-label={`${tone.label} — view status page`}>
      {inner}
    </Link>
  );
}
