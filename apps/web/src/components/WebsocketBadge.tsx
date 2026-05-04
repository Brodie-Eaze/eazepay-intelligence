'use client';

interface Props {
  connected: boolean;
}

export function WebsocketBadge({ connected }: Props): JSX.Element {
  return (
    <div className={`pill ${connected ? 'pill-success' : 'pill-danger'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-danger'}`} aria-hidden />
      <span className="text-[11px]">{connected ? 'Live' : 'Reconnecting…'}</span>
    </div>
  );
}
