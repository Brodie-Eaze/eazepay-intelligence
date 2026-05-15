'use client';

/**
 * A status dot that pulses for HEALTHY, holds steady for STALE,
 * and dims for IDLE. Used everywhere we surface ingestion freshness.
 */
export function PulseDot({
  status,
  size = 8,
}: {
  status: 'HEALTHY' | 'STALE' | 'IDLE';
  size?: number;
}): JSX.Element {
  const color = status === 'HEALTHY' ? '#22c55e' : status === 'STALE' ? '#f59e0b' : '#94a3b8';

  return (
    <span
      className="relative inline-block"
      style={{ width: size, height: size }}
      aria-label={status.toLowerCase()}
    >
      {status === 'HEALTHY' && (
        <span
          className="absolute inset-0 rounded-full animate-ping"
          style={{ background: color, opacity: 0.65 }}
        />
      )}
      <span className="absolute inset-0 rounded-full" style={{ background: color }} />
    </span>
  );
}
