'use client';

import { useCallback, useMemo } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

/**
 * URL-stateful filter bar. One declarative `filters` array yields:
 *   - inline controls (select / date-range / text) bound to `?key=value`
 *   - removable chips for every active filter
 *   - a "Clear all" affordance when any are active
 *
 * State lives entirely in the URL. Reload + back/forward survive by design.
 * Encoding: lowercase, kebab-case keys; raw string values (no JSON blobs).
 * For `date-range`, two keys are used: `${key}-from` and `${key}-to`.
 */

export type FilterType = 'select' | 'date-range' | 'text';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  /** URL key (lowercase, kebab-case). Date ranges add `-from` / `-to` suffixes. */
  key: string;
  /** Human label for the control + chip. */
  label: string;
  type: FilterType;
  /** Required for `select`. */
  options?: FilterOption[];
  /** Placeholder for `text`. */
  placeholder?: string;
}

interface Props {
  filters: FilterDef[];
}

export function FilterBar({ filters }: Props): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const writeParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params.toString());
      mutate(next);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const active = useMemo(() => collectActive(filters, params), [filters, params]);

  const clearOne = useCallback(
    (def: FilterDef) =>
      writeParams((next) => {
        if (def.type === 'date-range') {
          next.delete(`${def.key}-from`);
          next.delete(`${def.key}-to`);
        } else {
          next.delete(def.key);
        }
      }),
    [writeParams],
  );

  const clearAll = useCallback(
    () =>
      writeParams((next) => {
        for (const def of filters) {
          if (def.type === 'date-range') {
            next.delete(`${def.key}-from`);
            next.delete(`${def.key}-to`);
          } else {
            next.delete(def.key);
          }
        }
      }),
    [filters, writeParams],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        {filters.map((def) => (
          <FilterControl key={def.key} def={def} params={params} writeParams={writeParams} />
        ))}
      </div>
      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {active.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => clearOne(chip.def)}
              className="pill pill-info inline-flex items-center gap-1 hover:opacity-80"
              aria-label={`Remove filter ${chip.label}`}
            >
              <span className="text-muted">{chip.def.label}:</span>
              <span>{chip.label}</span>
              <span aria-hidden className="text-muted">
                ×
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] text-muted hover:text-ink underline-offset-2 hover:underline ml-1"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

interface ControlProps {
  def: FilterDef;
  params: URLSearchParams;
  writeParams: (mutate: (next: URLSearchParams) => void) => void;
}

function FilterControl({ def, params, writeParams }: ControlProps): JSX.Element {
  const baseCls =
    'bg-surface border border-line rounded-md px-2.5 py-1.5 text-ink2 outline-none focus:border-accent text-xs';

  if (def.type === 'select') {
    const value = params.get(def.key) ?? '';
    return (
      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted">{def.label}</span>
        <select
          value={value}
          onChange={(e) =>
            writeParams((next) => {
              if (e.target.value) next.set(def.key, e.target.value);
              else next.delete(def.key);
            })
          }
          className={baseCls}
        >
          <option value="">All</option>
          {(def.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (def.type === 'text') {
    const value = params.get(def.key) ?? '';
    return (
      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted">{def.label}</span>
        <input
          type="text"
          value={value}
          placeholder={def.placeholder}
          onChange={(e) =>
            writeParams((next) => {
              const v = e.target.value.trim();
              if (v) next.set(def.key, v);
              else next.delete(def.key);
            })
          }
          className={baseCls}
        />
      </label>
    );
  }

  // date-range
  const from = params.get(`${def.key}-from`) ?? '';
  const to = params.get(`${def.key}-to`) ?? '';
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted">{def.label}</span>
      <input
        type="date"
        value={from}
        onChange={(e) =>
          writeParams((next) => {
            if (e.target.value) next.set(`${def.key}-from`, e.target.value);
            else next.delete(`${def.key}-from`);
          })
        }
        className={baseCls}
      />
      <span className="text-muted">→</span>
      <input
        type="date"
        value={to}
        onChange={(e) =>
          writeParams((next) => {
            if (e.target.value) next.set(`${def.key}-to`, e.target.value);
            else next.delete(`${def.key}-to`);
          })
        }
        className={baseCls}
      />
    </label>
  );
}

interface ActiveChip {
  key: string;
  def: FilterDef;
  label: string;
}

function collectActive(filters: FilterDef[], params: URLSearchParams): ActiveChip[] {
  const out: ActiveChip[] = [];
  for (const def of filters) {
    if (def.type === 'date-range') {
      const from = params.get(`${def.key}-from`);
      const to = params.get(`${def.key}-to`);
      if (from || to) {
        out.push({
          key: def.key,
          def,
          label: `${from ?? '…'} → ${to ?? '…'}`,
        });
      }
      continue;
    }
    const raw = params.get(def.key);
    if (!raw) continue;
    if (def.type === 'select') {
      const match = (def.options ?? []).find((o) => o.value === raw);
      out.push({ key: def.key, def, label: match?.label ?? raw });
    } else {
      out.push({ key: def.key, def, label: raw });
    }
  }
  return out;
}

/** Helper: read the value of a non-date filter from current search params. */
export function readFilter(params: URLSearchParams, key: string): string {
  return params.get(key) ?? '';
}

/** Helper: read a date-range filter from current search params. */
export function readDateRange(params: URLSearchParams, key: string): { from: string; to: string } {
  return {
    from: params.get(`${key}-from`) ?? '',
    to: params.get(`${key}-to`) ?? '',
  };
}
