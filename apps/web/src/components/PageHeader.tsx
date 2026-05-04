'use client';

import { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}

export function PageHeader({ title, subtitle, action }: Props): JSX.Element {
  return (
    <header className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-ink text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
