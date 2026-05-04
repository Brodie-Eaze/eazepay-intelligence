'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useUser } from '@/lib/auth';
import {
  LayoutDashboard, Radio,
  Users, ShieldAlert, Wallet, Target,
  Inbox, Kanban,
  Landmark, Handshake, Percent,
  Building2,
  DollarSign, Layers, BookOpen, RotateCcw, Gauge, CreditCard,
  Activity, Webhook, ListOrdered, Monitor,
  Scroll, Eye, LogIn,
  ShieldCheck, Tags, KeyRound,
  type LucideIcon,
} from 'lucide-react';

interface NavItem { href: string; label: string; icon: LucideIcon; operatorOnly?: boolean; adminOnly?: boolean }
interface NavGroup { label: string; items: NavItem[] }

const GROUPS: NavGroup[] = [
  {
    label: 'Today',
    items: [
      { href: '/overview', label: 'Overview', icon: LayoutDashboard },
      { href: '/live', label: 'Live activity', icon: Radio },
    ],
  },
  {
    label: 'People',
    items: [
      { href: '/customers', label: 'Customer book', icon: Users, operatorOnly: true },
      { href: '/risk', label: 'Risk profiles', icon: ShieldAlert },
      { href: '/income', label: 'Income & affordability', icon: Wallet },
      { href: '/propensity', label: 'Propensity calibration', icon: Target },
    ],
  },
  {
    label: 'Applications',
    items: [
      { href: '/applications', label: 'All applications', icon: Inbox, operatorOnly: true },
      { href: '/applications/by-status', label: 'By status', icon: Kanban, operatorOnly: true },
    ],
  },
  {
    label: 'Decision engine',
    items: [
      { href: '/lenders', label: 'Lender book', icon: Landmark },
      { href: '/buzzpay', label: 'BuzzPay deals', icon: Handshake },
      { href: '/buzzpay/apr', label: 'APR mix', icon: Percent },
    ],
  },
  {
    label: 'Network',
    items: [
      { href: '/partners', label: 'Partners', icon: Building2 },
    ],
  },
  {
    label: 'Money',
    items: [
      { href: '/revenue', label: 'Revenue', icon: DollarSign },
      { href: '/revenue/streams', label: 'By stream', icon: Layers },
      { href: '/revenue/ledger', label: 'Ledger', icon: BookOpen, operatorOnly: true },
      { href: '/revenue/clawbacks', label: 'Clawbacks', icon: RotateCcw, operatorOnly: true },
      { href: '/highsale', label: 'HighSale', icon: Gauge },
      { href: '/micamp', label: 'MiCamp', icon: CreditCard },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/ops/health', label: 'System health', icon: Activity, operatorOnly: true },
      { href: '/ops/webhooks', label: 'Webhook events', icon: Webhook, operatorOnly: true },
      { href: '/ops/queues', label: 'Queues', icon: ListOrdered, operatorOnly: true },
      { href: '/ops/sessions', label: 'Sessions', icon: Monitor, adminOnly: true },
    ],
  },
  {
    label: 'Governance',
    items: [
      { href: '/audit', label: 'Audit log', icon: Scroll, operatorOnly: true },
      { href: '/audit/pii', label: 'PII access', icon: Eye, adminOnly: true },
      { href: '/audit/logins', label: 'Logins', icon: LogIn, operatorOnly: true },
    ],
  },
  {
    label: 'Admin',
    items: [
      { href: '/admin', label: 'Users & roles', icon: ShieldCheck, adminOnly: true },
      { href: '/admin/pricing', label: 'Pricing', icon: Tags, adminOnly: true },
      { href: '/admin/secrets', label: 'Secrets', icon: KeyRound, adminOnly: true },
    ],
  },
];

export function Sidebar(): JSX.Element {
  const path = usePathname();
  const user = useUser();

  const filtered = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => {
      if (item.operatorOnly && user?.role === 'VIEWER') return false;
      if (item.adminOnly && user?.role !== 'ADMIN') return false;
      return true;
    }),
  })).filter((g) => g.items.length > 0);

  return (
    <aside className="w-64 shrink-0 border-r border-line2 bg-surface px-3 py-6 flex flex-col overflow-y-auto">
      <Link href="/overview" className="block mb-7 px-3">
        <div className="font-semibold tracking-tight text-ink text-[17px] leading-none">EazePay</div>
        <div className="text-accent text-[10px] font-semibold tracking-[0.18em] mt-1.5">INTELLIGENCE</div>
      </Link>

      {filtered.map((group) => (
        <div key={group.label} className="mb-5">
          <div className="px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-soft mb-2">{group.label}</div>
          <nav className="space-y-0.5">
            {group.items.map((item) => {
              const active = path === item.href || (item.href !== '/overview' && path?.startsWith(`${item.href}/`));
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] tracking-tight transition ${
                    active
                      ? 'bg-ink text-surface font-medium shadow-sm'
                      : 'text-ink2 hover:bg-paper'
                  }`}
                >
                  <Icon
                    size={16}
                    strokeWidth={active ? 2 : 1.75}
                    className={active ? 'text-surface' : 'text-soft'}
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      ))}

      <div className="mt-auto px-3 pt-4 border-t border-line2 text-[10px] text-soft space-y-0.5">
        <div>v0.1.0 · {process.env.NEXT_PUBLIC_ENV ?? 'local'}</div>
        <div className="truncate">{user?.email}</div>
      </div>
    </aside>
  );
}
