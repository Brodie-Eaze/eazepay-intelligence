'use client';

import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';

const SECRETS = [
  { key: 'EAZEPAY_APP_WEBHOOK_SECRET', label: 'EazePay App HMAC secret', status: 'PROCESSED' },
  { key: 'PIXIE_WEBHOOK_SECRET', label: 'Pixie HMAC secret', status: 'PROCESSED' },
  { key: 'MICAMP_WEBHOOK_SECRET', label: 'MiCamp HMAC secret', status: 'PROCESSED' },
  { key: 'JWT_ACCESS_SECRET', label: 'JWT access signing key', status: 'PROCESSED' },
  { key: 'JWT_REFRESH_SECRET', label: 'JWT refresh signing key', status: 'PROCESSED' },
  { key: 'PII_ENCRYPTION_KEY', label: 'PII encryption key (AES-256-GCM)', status: 'PROCESSED' },
  { key: 'PII_HASH_SECRET', label: 'PII hash pepper (HMAC SHA-256)', status: 'PROCESSED' },
];

export default function SecretsPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhook secrets & keys"
        subtitle="Inventory of every secret the platform depends on · rotation playbook in SECURITY.md"
      />

      <SectionCard
        title="Inventory"
        subtitle="loaded from .env at boot · validated by Zod"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Key</th>
                <th>Purpose</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {SECRETS.map((s) => (
                <tr key={s.key}>
                  <td className="numeric">
                    <code className="kbd">{s.key}</code>
                  </td>
                  <td className="text-ink2">{s.label}</td>
                  <td>
                    <StatusPill>{s.status}</StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Rotation playbook" bodyClassName="p-5">
        <ol className="list-decimal list-inside text-sm text-ink2 space-y-1">
          <li>Generate the new secret (32 bytes for HMACs, 32-byte base64 for PII).</li>
          <li>
            For HMAC webhook secrets: coordinate the cutover window with the source vendor. Update{' '}
            <code className="kbd">.env</code>, redeploy.
          </li>
          <li>
            For PII keys: register the new key version in <code className="kbd">encryption.ts</code>
            ; do not retire the old version while ciphertext exists. Backfill is a separate v1.1
            procedure.
          </li>
          <li>
            For JWT secrets: rotation invalidates all sessions. Plan a maintenance window or
            implement RS256 + KMS first (v1.1).
          </li>
        </ol>
      </SectionCard>
    </div>
  );
}
