'use client';

/**
 * Targeted breakpoints: < md collapses table → stacked cards.
 */

import Link from 'next/link';
import { formatMoney, formatTime } from '@/lib/format';
import { Monogram } from './Monogram';
import { StatusPill } from './StatusPill';
import { MobileCardList, MobileCardRow } from './MobileCardRow';

export interface ActivityRow {
  eventTime: string;
  kind: 'application' | 'decision' | 'funding' | 'revenue' | 'partner';
  partnerId: string;
  partnerName: string;
  description: string;
  amount: string | null;
}

const KIND_LABEL: Record<ActivityRow['kind'], string> = {
  application: 'Application',
  decision: 'Decision',
  funding: 'Funding',
  revenue: 'Revenue',
  partner: 'Partner',
};

const KIND_TONE: Record<ActivityRow['kind'], string> = {
  application: 'pill-info',
  decision: 'pill-warn',
  funding: 'pill-success',
  revenue: 'pill-success',
  partner: 'pill-muted',
};

export function RecentActivityTable({ rows }: { rows: ActivityRow[] }): JSX.Element {
  if (rows.length === 0) {
    return <div className="text-sm text-muted px-5 py-6">No recent activity.</div>;
  }
  return (
    <>
      {/* Desktop / tablet ≥ md */}
      <div className="hidden md:block overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>Partner</th>
              <th>Detail</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.eventTime}-${i}`}>
                <td className="numeric text-muted whitespace-nowrap">{formatTime(r.eventTime)}</td>
                <td>
                  <span className={`pill ${KIND_TONE[r.kind]}`}>{KIND_LABEL[r.kind]}</span>
                </td>
                <td>
                  <Link
                    href={`/partners/${r.partnerId}`}
                    className="inline-flex items-center gap-2 text-ink hover:text-accent"
                  >
                    <Monogram label={r.partnerName} />
                    <span>{r.partnerName}</span>
                  </Link>
                </td>
                <td className="text-ink2">{prettify(r.description)}</td>
                <td className="numeric text-right text-ink">
                  {r.amount ? formatMoney(r.amount) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile < md — stacked cards */}
      <MobileCardList>
        {rows.map((r, i) => (
          <MobileCardRow
            key={`m-${r.eventTime}-${i}`}
            href={`/partners/${r.partnerId}`}
            title={r.partnerName}
            subtitle={r.description}
            badge={<span className={`pill ${KIND_TONE[r.kind]}`}>{KIND_LABEL[r.kind]}</span>}
            fields={[
              { label: 'When', value: formatTime(r.eventTime) },
              {
                label: 'Amount',
                value: r.amount ? formatMoney(r.amount) : '—',
                align: 'right',
              },
            ]}
          />
        ))}
      </MobileCardList>
    </>
  );
}

function prettify(s: string): React.ReactNode {
  // Wrap UPPER_TOKENS with a status pill if recognized.
  const known = [
    'APPROVED',
    'DECLINED',
    'FUNDED',
    'FAILED',
    'CLAWBACK',
    'REVERSAL',
    'PIXIE_MARGIN',
    'PROCESSING_FEE',
    'PIXIE',
    'MICAMP',
  ];
  const parts = s.split(/(\s+|·)/);
  return parts.map((p, i) =>
    known.includes(p) ? <StatusPill key={i}>{p}</StatusPill> : <span key={i}>{p}</span>,
  );
}
