'use client';

import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';

/**
 * Customer-facing security posture page. Sentence case, direct voice.
 * Anything claimed here must match what the platform actually does —
 * if a control changes, update this page in the same PR.
 */

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-1 md:gap-4 py-2 border-b border-line2 last:border-b-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-soft">{label}</div>
      <div className="text-sm text-ink2">{value}</div>
    </div>
  );
}

export default function SecurityPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        subtitle="How EazePay Intelligence protects customer and tenant data"
      />

      <SectionCard title="Encryption" subtitle="At rest and in transit">
        <Row label="At rest" value="AES-256-GCM, full-disk and per-column for sensitive fields" />
        <Row label="In transit" value="TLS 1.3 only, modern cipher suites, HSTS preload" />
        <Row
          label="Key management"
          value="Envelope encryption with per-organization data encryption keys, rotated annually"
        />
        <Row label="Backups" value="Encrypted with the same scheme, region-isolated, 35-day PITR" />
      </SectionCard>

      <SectionCard title="Access control" subtitle="Authentication and authorization">
        <Row
          label="Authentication"
          value="Session-cookie auth with MFA required for ADMIN and operator roles"
        />
        <Row
          label="Authorization"
          value="Role-based access control: VIEWER, OPERATOR, ADMIN, INVESTOR"
        />
        <Row
          label="Tenant isolation"
          value="Postgres row-level security enforced on every tenant-scoped table"
        />
        <Row label="API tokens" value="Scoped, optional TTL, revocable, last-used tracking" />
        <Row
          label="Audit"
          value="Every privileged action and PII read is logged with actor, target, and request ID"
        />
      </SectionCard>

      <SectionCard title="Compliance" subtitle="Frameworks and standards">
        <Row
          label="SOC 2 Type II"
          value="In progress — observation window underway, report Q4 2026"
        />
        <Row
          label="Australian Privacy Principles"
          value="Designed to align with APP 1 through APP 13"
        />
        <Row label="GDPR" value="Aligned with Article 32 technical and organizational measures" />
        <Row label="PCI scope" value="Out of scope — no cardholder data stored or transmitted" />
      </SectionCard>

      <SectionCard title="Data residency" subtitle="Where customer data lives">
        <Row label="Primary region" value="Australia (Sydney) — default for all tenants" />
        <Row label="Optional region" value="United States — available for US-domiciled tenants" />
        <Row
          label="Region pinning"
          value="Selected per organization at provisioning; data does not cross regions"
        />
      </SectionCard>

      <SectionCard title="Incident response" subtitle="Detection, response, notification">
        <Row label="Monitoring" value="24x7 alerting on security and availability signals" />
        <Row
          label="Response SLA"
          value="P1 acknowledged within 15 minutes, customer notification within 72 hours"
        />
        <Row
          label="Post-incident"
          value="Written postmortem shared with affected tenants; corrective actions tracked to close"
        />
      </SectionCard>

      <SectionCard title="Reporting a vulnerability">
        <p className="text-sm text-ink2">
          Send security reports to{' '}
          <a className="text-accent hover:underline" href="mailto:security@aureanos.com">
            security@aureanos.com
          </a>
          . Acknowledged within one business day. Coordinated disclosure preferred; safe-harbor for
          good-faith research.
        </p>
      </SectionCard>
    </div>
  );
}
