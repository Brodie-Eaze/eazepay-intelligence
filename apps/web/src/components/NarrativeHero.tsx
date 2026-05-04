'use client';

import { ReactNode } from 'react';

interface KpiInline { label: string; value: string; hint?: string }

interface Props {
  badge?: string;
  narrative: ReactNode;
  subtext: string;
  kpis: KpiInline[];
}

export function NarrativeHero({ badge, narrative, subtext, kpis }: Props): JSX.Element {
  return (
    <div className="bg-hero text-surface rounded-2xl px-8 pt-7 pb-7 relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(800px 240px at 100% 0%, rgba(37,99,235,0.18), transparent 60%)' }}
      />
      <div className="relative">
        {badge && (
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] tracking-wide bg-white/5 border border-heroLine text-surface/70">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {badge}
          </div>
        )}
        <h1 className="mt-4 text-[28px] md:text-[32px] font-semibold tracking-tight leading-[1.15] max-w-4xl">
          {narrative}
        </h1>
        <p className="mt-2 text-surface/55 text-sm leading-relaxed max-w-3xl">{subtext}</p>

        <div className="mt-7 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-x-10 gap-y-4 border-t border-heroLine pt-5">
          {kpis.map((k) => (
            <div key={k.label}>
              <div className="text-[10px] uppercase tracking-[0.12em] text-surface/45 font-medium">{k.label}</div>
              <div className="numeric text-[22px] font-semibold mt-1 tracking-tight">{k.value}</div>
              {k.hint && <div className="text-[11px] text-surface/40 mt-0.5">{k.hint}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
