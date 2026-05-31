'use client';

import { LineChart, Line, ResponsiveContainer } from 'recharts';

interface Props {
  label: string;
  value: string;
  delta?: { text: string; tone: 'up' | 'down' | 'flat' };
  /**
   * Pre-shaped recharts series. Renders a wider area-style line inside the
   * card body. Predates `sparkline` and remains in use by callers that
   * want the larger 28px chart.
   */
  spark?: Array<{ x: number; y: number }>;
  /**
   * Tiny inline 60x16 SVG line at the bottom-right of the card. No deps,
   * no axes, single accent stroke. Pass a raw number series (e.g. last 30
   * days of revenue). Anything <2 points is ignored.
   */
  sparkline?: number[];
  hint?: string;
}

const TONE = {
  up: 'text-success',
  down: 'text-danger',
  flat: 'text-muted',
} as const;

const SPARK_W = 60;
const SPARK_H = 16;
const SPARK_PAD = 1; // keep stroke inside the viewBox so it never clips

function sparkPath(values: number[]): string {
  // Min/max normalize into the padded viewbox. A flat series collapses to
  // a midline rather than dividing by zero.
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const usableW = SPARK_W - SPARK_PAD * 2;
  const usableH = SPARK_H - SPARK_PAD * 2;
  const step = usableW / (values.length - 1);
  return values
    .map((v, i) => {
      const x = SPARK_PAD + i * step;
      const y = SPARK_PAD + usableH - ((v - min) / range) * usableH;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

export function KpiCard({ label, value, delta, spark, sparkline, hint }: Props): JSX.Element {
  const hasSparkline = sparkline && sparkline.length >= 2;
  return (
    <div className="card hover-lift px-4 py-3 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.10em] text-muted font-medium">
          {label}
        </span>
        {delta && (
          <span className={`text-[11px] numeric font-medium ${TONE[delta.tone]}`}>
            {delta.text}
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="numeric text-[20px] leading-tight font-semibold text-ink tracking-tight">
          {value}
        </div>
        {hasSparkline && (
          <svg
            viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
            width={SPARK_W}
            height={SPARK_H}
            className="text-accent shrink-0"
            aria-hidden="true"
          >
            <path
              d={sparkPath(sparkline)}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.25}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
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
