'use client';

import { ReactNode, useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function SectionCard({
  title,
  subtitle,
  action,
  className,
  bodyClassName,
  collapsible,
  defaultOpen = true,
  children,
}: Props): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);

  const headerInner = (
    <>
      <div className="flex items-center gap-2">
        {collapsible && (
          <ChevronDown
            size={14}
            strokeWidth={2}
            className={`text-soft transition-transform ${open ? '' : '-rotate-90'}`}
          />
        )}
        <div>
          <div className="section-title">{title}</div>
          {subtitle && <div className="section-sub">{subtitle}</div>}
        </div>
      </div>
      {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
    </>
  );

  return (
    <section className={`section ${className ?? ''}`}>
      {collapsible ? (
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((o) => !o);
            }
          }}
          className="section-head w-full hover:bg-paper/50 transition cursor-pointer select-none"
        >
          {headerInner}
        </div>
      ) : (
        <header className="section-head">{headerInner}</header>
      )}
      {(!collapsible || open) && <div className={bodyClassName ?? 'section-body'}>{children}</div>}
    </section>
  );
}
