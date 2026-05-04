'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatPct } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatusPill } from '@/components/StatusPill';
import { KpiCard } from '@/components/KpiCard';
import { MiniBar } from '@/components/MiniBar';

interface LenderTimeline {
  lenderName: string;
  monthly: Array<{ bucket: string; submitted: number; approved: number; funded: number; avgApr: string | null; fundedAmount: string }>;
  aprDistribution: Array<{ bucketLabel: string; count: number }>;
  recentDecisions: Array<{
    id: string;
    externalApplicationId: string;
    decision: string;
    decisionTimestamp: string;
    apr: string | null;
    approvalAmount: string | null;
    fundingStatus: string;
    fundingAmount: string | null;
  }>;
}

export default function LenderDetail({ params }: { params: { name: string } }): JSX.Element {
  const lenderName = decodeURIComponent(params.name);
  const q = useQuery({
    queryKey: ['lender.timeline', lenderName],
    queryFn: () => api<LenderTimeline>(`/lenders/${encodeURIComponent(lenderName)}/timeline`),
  });

  if (q.isLoading) return <div className="text-muted">Loading…</div>;
  if (!q.data) return <div className="card card-pad text-danger">Lender not found.</div>;

  const t = q.data;
  const totalSub = t.monthly.reduce((s, m) => s + m.submitted, 0);
  const totalAppr = t.monthly.reduce((s, m) => s + m.approved, 0);
  const totalFunded = t.monthly.reduce((s, m) => s + m.funded, 0);
  const totalFundedAmt = t.monthly.reduce((s, m) => s + Number(m.fundedAmount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={lenderName}
        subtitle="Lender deep-dive · per-month performance · APR distribution · recent decisions"
        action={<Link href="/lenders" className="text-xs text-accent hover:underline">← All lenders</Link>}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Submissions" value={totalSub.toLocaleString('en-AU')} hint="lifetime" />
        <KpiCard label="Approved" value={totalAppr.toLocaleString('en-AU')} hint={formatPct(totalSub ? totalAppr / totalSub : 0)} />
        <KpiCard label="Funded" value={totalFunded.toLocaleString('en-AU')} hint={formatPct(totalAppr ? totalFunded / totalAppr : 0)} />
        <KpiCard label="Funded volume" value={formatMoney(totalFundedAmt)} hint="lifetime $" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SectionCard title="Monthly performance" subtitle="last 24 months" className="lg:col-span-2" bodyClassName="p-3">
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[...t.monthly].reverse()} margin={{ top: 10, right: 16, bottom: 8, left: 8 }}>
                <CartesianGrid stroke="#E5E7EB" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={(v) => new Date(v).toLocaleDateString('en-AU', { month: 'short' })} stroke="#94A3B8" fontSize={11} />
                <YAxis stroke="#94A3B8" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(v) => new Date(v).toLocaleDateString('en-AU')}
                />
                <Bar dataKey="submitted" fill="#CBD5E1" name="Submitted" radius={[3, 3, 0, 0]} />
                <Bar dataKey="approved" fill="#3B82F6" name="Approved" radius={[3, 3, 0, 0]} />
                <Bar dataKey="funded" fill="#0F172A" name="Funded" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        <SectionCard title="APR distribution" subtitle="approved decisions">
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={t.aprDistribution} margin={{ top: 10, right: 8, bottom: 8, left: 8 }}>
                <CartesianGrid stroke="#E5E7EB" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="bucketLabel" stroke="#94A3B8" fontSize={10} />
                <YAxis stroke="#94A3B8" fontSize={11} />
                <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="count" fill="#3B82F6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Monthly detail" subtitle="numbers behind the chart" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Month</th>
                <th className="text-right">Submitted</th>
                <th className="text-right">Approved</th>
                <th className="text-right">Funded</th>
                <th className="text-right">Approval rate</th>
                <th className="text-right">Avg APR</th>
                <th className="text-right">Funded $</th>
              </tr>
            </thead>
            <tbody>
              {t.monthly.map((m) => (
                <tr key={m.bucket}>
                  <td className="numeric text-muted">{new Date(m.bucket).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}</td>
                  <td className="numeric text-right text-ink2">{m.submitted}</td>
                  <td className="numeric text-right text-ink2">{m.approved}</td>
                  <td className="numeric text-right text-ink">{m.funded}</td>
                  <td className="numeric text-right text-ink2">{formatPct(m.submitted ? m.approved / m.submitted : 0)}</td>
                  <td className="numeric text-right text-ink2">{m.avgApr ? `${Number(m.avgApr).toFixed(2)}%` : '—'}</td>
                  <td className="numeric text-right text-ink font-medium">{formatMoney(m.fundedAmount)}</td>
                </tr>
              ))}
              {t.monthly.length === 0 && <tr><td colSpan={7} className="text-center text-muted py-8">No monthly data.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Recent decisions" subtitle="most-recent 50 across all partners" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Application</th>
                <th>Decision</th>
                <th className="text-right">APR</th>
                <th className="text-right">Approved $</th>
                <th>Funding</th>
                <th className="text-right">Funded $</th>
              </tr>
            </thead>
            <tbody>
              {t.recentDecisions.map((d) => (
                <tr key={d.id}>
                  <td className="numeric text-muted whitespace-nowrap">{formatDateTime(d.decisionTimestamp)}</td>
                  <td className="numeric"><code className="kbd">{d.externalApplicationId}</code></td>
                  <td><StatusPill>{d.decision}</StatusPill></td>
                  <td className="numeric text-right text-ink2">{d.apr ? `${Number(d.apr).toFixed(2)}%` : '—'}</td>
                  <td className="numeric text-right text-ink2">{d.approvalAmount ? formatMoney(d.approvalAmount) : '—'}</td>
                  <td><StatusPill>{d.fundingStatus}</StatusPill></td>
                  <td className="numeric text-right text-success font-medium">{d.fundingAmount ? formatMoney(d.fundingAmount) : '—'}</td>
                </tr>
              ))}
              {t.recentDecisions.length === 0 && <tr><td colSpan={7} className="text-center text-muted py-8">No decisions.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
