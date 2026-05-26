'use client';

import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader';
import { AuditTable } from '@/components/AuditTable';
import { FilterBar, type FilterDef } from '@/components/ui/FilterBar';

/**
 * Audit log surface — wires the canonical FilterBar so action / resource /
 * date-range filters survive reload + back/forward and are link-shareable.
 */
const FILTERS: FilterDef[] = [
  { key: 'action', label: 'Action', type: 'text', placeholder: 'e.g. user.login' },
  { key: 'resource', label: 'Resource', type: 'text', placeholder: 'e.g. application' },
  { key: 'occurred', label: 'When', type: 'date-range' },
];

export default function AuditPage(): JSX.Element {
  const params = useSearchParams();
  const action = params.get('action') ?? '';
  const resource = params.get('resource') ?? '';
  const from = params.get('occurred-from') ?? '';
  const to = params.get('occurred-to') ?? '';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        subtitle="Every mutation · every PII access · every WS connect/disconnect · append-only at the database role"
        action={<FilterBar filters={FILTERS} />}
      />
      <AuditTable
        title="All actions"
        queryKey={['audit.all', action, resource, from, to]}
        filter={{
          action: action || undefined,
          resourceType: resource || undefined,
          from: from || undefined,
          to: to || undefined,
        }}
      />
    </div>
  );
}
