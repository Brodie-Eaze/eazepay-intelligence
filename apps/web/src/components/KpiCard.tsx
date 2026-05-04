'use client';

import { LineChart, Line, ResponsiveContainer } from 'recharts';

interface Props {
  label: string;
  value: string;
  delta?: { text: string; tone: 'up' | 'down' | 'flat' };
  spark?: Array<{ x: number; y: number }>;
  hint?: string;
}

const TONE = {
  up: 'text-success',
  down: 'text-danger',
  flat: 'text-muted',
} as const;

export function KpiCard({ label, value, delta, spark, hint }: Props): JSX.Element {
  return (
    <div className="card px-4 py-3 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.10em] text-muted font-medium">{label}</span>
        {delta && <span className={`text-[11px] numeric font-medium ${TONE[delta.tone]}`}>{delta.text}</span>}
      </div>
      <div className="numeric text-[20px] leading-tight font-semibold text-ink tracking-tight">{value}</div>
      {hint && <div className="text-[11px] text-muted leading-tight">{hint}</div>}
      {spark && spark.length > 0 && (
        <div className="h-7 -mx-1 mt-0.5">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={spark}>
              <Line type="monotone" dataKey="y" stroke="#3B82F6" dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
