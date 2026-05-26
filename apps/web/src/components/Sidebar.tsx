'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useUser } from '@/lib/auth';
import { StaggerList } from '@/components/motion';
import {
  LayoutDashboard,
  Radio,
  Users,
  ShieldAlert,
  Wallet,
  Target,
  Inbox,
  Kanban,
  Landmark,
  Building2,
  DollarSign,
  Layers,
  BookOpen,
  Scale,
  Gauge,
  CreditCard,
  Sparkles,
  Activity,
  Webhook,
  ListOrdered,
  Monitor,
  Scroll,
  Eye,
  LogIn,
  ShieldCheck,
  Tags,
  KeyRound,
  Search,
  Bell,
  FileDown,
  CalendarClock,
  Tag,
  Webhook as WebhookIcon,
  Key,
  Briefcase,
  Database,
  Heart,
  Lock,
  History,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  operatorOnly?: boolean;
  adminOnly?: boolean;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Sidebar groups for a data-warehouse-first IA.
 *
 * Top-half (groups 1–4) is the analytical surface the team uses daily:
 *   what's happening, in which business, across which customers, for
 *   how much revenue.
 *
 * Middle (group 5) is provenance — "where does this data come from?"
 *   Each upstream system gets its own landing.
 *
 * Bottom-half (groups 6–8) is operations + governance + admin. Still
 *   in the nav (the team needs to find these), just visually demoted.
 *
 * Every route under apps/web/src/app/(app)/ that isn't a dynamic-param
 * detail page appears below. If you add a new top-level route, add a
 * line here too.
 */
const GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/overview', label: 'Holdco overview', icon: LayoutDashboard },
      { href: '/live', label: 'Live activity', icon: Radio },
    ],
  },
  {
    label: 'Holdco',
    items: [
      { href: '/portfolio', label: 'Holdco', icon: Briefcase },
      // Per-business drill-down lives at /portfolio/[vertical]/[business];
      // click a row in the rollup to drill in.
    ],
  },
  {
    label: 'Customers & applications',
    items: [
      { href: '/customers', label: 'Customer book', icon: Users, operatorOnly: true },
      { href: '/applications', label: 'All applications', icon: Inbox, operatorOnly: true },
      { href: '/applications/by-status', label: 'By status', icon: Kanban, operatorOnly: true },
      { href: '/risk', label: 'Risk profiles', icon: ShieldAlert },
      { href: '/income', label: 'Income & affordability', icon: Wallet },
      { href: '/propensity', label: 'Propensity calibration', icon: Target },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { href: '/revenue', label: 'Revenue overview', icon: DollarSign },
      { href: '/revenue/streams', label: 'By stream', icon: Layers },
      { href: '/revenue/ledger', label: 'Append-only ledger', icon: BookOpen, operatorOnly: true },
      {
        href: '/revenue/reconciliation',
        label: 'Reconciliation',
        icon: Scale,
        operatorOnly: true,
      },
    ],
  },
  {
    label: 'Data sources',
    items: [
      { href: '/data-sources', label: 'All sources', icon: Database },
      { href: '/highsale', label: 'HighSale (EZ Check)', icon: Gauge },
      { href: '/pixie', label: 'Pixie', icon: Sparkles },
      { href: '/micamp', label: 'MiCamp', icon: CreditCard },
      { href: '/lenders', label: 'Lenders', icon: Landmark },
      { href: '/partners', label: 'Partners', icon: Building2 },
      { href: '/ops/webhooks', label: 'Webhook events log', icon: Webhook, operatorOnly: true },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/alerts', label: 'Alerts', icon: Bell, operatorOnly: true },
      { href: '/search', label: 'Global search', icon: Search },
      { href: '/ops/health', label: 'System health', icon: Activity, operatorOnly: true },
      { href: '/ops/queues', label: 'Job queues', icon: ListOrdered, operatorOnly: true },
      { href: '/ops/sessions', label: 'Sessions', icon: Monitor, adminOnly: true },
      { href: '/tags', label: 'Tags', icon: Tag, operatorOnly: true },
    ],
  },
  {
    label: 'Governance',
    items: [
      { href: '/audit', label: 'Audit log', icon: Scroll, operatorOnly: true },
      { href: '/audit/pii', label: 'PII access log', icon: Eye, adminOnly: true },
      { href: '/audit/logins', label: 'Login log', icon: LogIn, operatorOnly: true },
    ],
  },
  {
    label: 'Reference',
    items: [
      // Per-source schema dictionaries — engineering / analyst lookup.
      // Add new schemas here as we wire more data planes.
      { href: '/highsale/schema', label: 'HighSale schema · 70 fields', icon: Database },
    ],
  },
  {
    label: 'Admin & workspace',
    items: [
      { href: '/admin', label: 'Users & roles', icon: ShieldCheck, adminOnly: true },
      { href: '/admin/pricing', label: 'Pricing config', icon: Tags, adminOnly: true },
      { href: '/admin/secrets', label: 'Secrets inventory', icon: KeyRound, adminOnly: true },
      { href: '/tokens', label: 'API tokens', icon: Key },
      { href: '/exports', label: 'Data exports', icon: FileDown },
      { href: '/reports', label: 'Scheduled reports', icon: CalendarClock },
      {
        href: '/subscriptions',
        label: 'Outbound webhooks',
        icon: WebhookIcon,
        operatorOnly: true,
      },
    ],
  },
  {
    // Trust surfaces — public-facing transparency. Reachable via the
    // status badge + footer link too, but the team needs a direct path
    // from the nav. Sits at the bottom so it doesn't compete with the
    // analytical groups above.
    label: 'Trust',
    items: [
      { href: '/status', label: 'Status', icon: Heart },
      { href: '/security', label: 'Security', icon: Lock },
      { href: '/changelog', label: 'Changelog', icon: History },
    ],
  },
];

export function Sidebar(): JSX.Element {
  const path = usePathname();
  const user = useUser();

  const filtered = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => {
      // operatorOnly hides items from VIEWER and INVESTOR. Without the
      // INVESTOR clause, an investor-scope user sees admin/ops surfaces
      // they shouldn't reach (the server enforces scope at the API,
      // but the sidebar should not advertise routes that 403 on click).
      if (item.operatorOnly && (user?.role === 'VIEWER' || user?.role === 'INVESTOR')) return false;
      if (item.adminOnly && user?.role !== 'ADMIN') return false;
      return true;
    }),
  })).filter((g) => g.items.length > 0);

  // Single active route per render. Naive prefix matching ("does the
  // path start with this href?") double-highlights when one item's
  // href is a prefix of another (`/revenue` + `/revenue/streams`,
  // `/applications` + `/applications/by-status`, `/admin` + `/admin/pricing`,
  // etc.). We pick the longest-matching href so only the most-specific
  // item lights up.
  const activeHref = ((): string | null => {
    if (!path) return null;
    let bestHref: string | null = null;
    let bestLen = -1;
    for (const group of filtered) {
      for (const item of group.items) {
        if (path === item.href) return item.href; // exact wins
        if (item.href !== '/overview' && path.startsWith(`${item.href}/`)) {
          if (item.href.length > bestLen) {
            bestLen = item.href.length;
            bestHref = item.href;
          }
        }
      }
    }
    return bestHref;
  })();

  return (
    <aside className="w-64 shrink-0 border-r border-line2 bg-surface px-3 py-6 flex flex-col h-full overflow-y-auto">
      <Link href="/overview" className="block mb-7 px-3">
        <div className="font-semibold tracking-tight text-ink text-[17px] leading-none">
          EazePay
        </div>
        <div className="text-accent text-[10px] font-semibold tracking-[0.18em] mt-1.5">
          INTELLIGENCE
        </div>
      </Link>

      {filtered.map((group) => (
        <div key={group.label} className="mb-5">
          <div className="px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-soft mb-2">
            {group.label}
          </div>
          <StaggerList as="nav" className="space-y-0.5" stagger={25} maxAnimated={12}>
            {group.items.map((item) => {
              const active = item.href === activeHref;
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
          </StaggerList>
        </div>
      ))}

      <div className="mt-auto px-3 pt-4 border-t border-line2 text-[10px] text-soft space-y-0.5">
        <div>v0.1.0 · {process.env.NEXT_PUBLIC_ENV ?? 'local'}</div>
        <div className="truncate">{user?.email}</div>
      </div>
    </aside>
  );
}
