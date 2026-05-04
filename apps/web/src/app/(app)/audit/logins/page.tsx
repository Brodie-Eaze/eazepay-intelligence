'use client';

import { PageHeader } from '@/components/PageHeader';
import { AuditTable } from '@/components/AuditTable';

export default function LoginsAuditPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Login activity"
        subtitle="Every successful + failed login attempt · refresh rotations · scope toggles"
      />
      <AuditTable title="USER_LOGIN" queryKey={['audit.logins.ok']} filter={{ action: 'USER_LOGIN' }} />
      <AuditTable title="USER_LOGIN_FAILED" subtitle="bad password / unknown email / MFA fail" queryKey={['audit.logins.fail']} filter={{ action: 'USER_LOGIN_FAILED' }} />
      <AuditTable title="USER_SCOPE_CHANGED" subtitle="investor / standard toggles" queryKey={['audit.scope']} filter={{ action: 'USER_SCOPE_CHANGED' }} />
    </div>
  );
}
