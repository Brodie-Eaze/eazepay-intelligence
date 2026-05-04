'use client';

import { PageHeader } from '@/components/PageHeader';
import { AuditTable } from '@/components/AuditTable';

export default function AuditPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        subtitle="Every mutation · every PII access · every WS connect/disconnect · append-only at the database role"
      />
      <AuditTable title="All actions" queryKey={['audit.all']} />
    </div>
  );
}
