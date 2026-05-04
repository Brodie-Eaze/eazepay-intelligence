'use client';

import { PageHeader } from '@/components/PageHeader';
import { AuditTable } from '@/components/AuditTable';

export default function PiiAuditPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="PII access log"
        subtitle="Every operator who decrypted consumer PII · who, when, which application"
      />
      <AuditTable
        title="PII_ACCESSED events"
        subtitle="every reveal triggers an entry"
        queryKey={['audit.pii']}
        filter={{ action: 'PII_ACCESSED' }}
      />
    </div>
  );
}
