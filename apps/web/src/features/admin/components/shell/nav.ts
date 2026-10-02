import {
  ArrowLeftRight,
  BadgeDollarSign,
  Banknote,
  Bell,
  Globe,
  LayoutDashboard,
  ListChecks,
  Mail,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Truck,
  Users,
} from 'lucide-react'
import type { AttentionCounts } from '@/features/admin/queries/attention'

/**
 * Every admin page, in the sidebar's order (ADMIN-SPEC §5.1, §9). A badge
 * counts what needs a person there, from `admin_attention_counts`; the count
 * is read out with the link's name.
 */

export type AdminNavItem = {
  href: string
  label: string
  icon: typeof LayoutDashboard
  exact?: boolean
  /** How many need a person here, and the words for them. */
  badge?: { count: (counts: AttentionCounts) => number; words: string }
}

export type AdminNavGroup = { label: string; items: AdminNavItem[] }

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    label: 'Operations',
    items: [
      { href: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
      {
        href: '/admin/orders',
        label: 'Orders',
        icon: Receipt,
        badge: { count: (c) => c.stuckOrders, words: 'stuck' },
      },
      {
        href: '/admin/refunds',
        label: 'Refunds',
        icon: ArrowLeftRight,
        badge: { count: (c) => c.refunds + c.incidents, words: 'need a person' },
      },
      {
        href: '/admin/queue',
        label: 'Queue',
        icon: ListChecks,
        badge: { count: (c) => c.jobs + c.pendingWithoutJob, words: 'need a person' },
      },
      {
        href: '/admin/alerts',
        label: 'Alerts',
        icon: Bell,
        badge: { count: (c) => c.alertsCritical, words: 'critical' },
      },
    ],
  },
  {
    label: 'Money',
    items: [
      {
        href: '/admin/supplier',
        label: 'Supplier',
        icon: Truck,
        badge: { count: (c) => c.ledgerUnexplained, words: 'unexplained charges' },
      },
      { href: '/admin/money', label: 'Money', icon: Banknote },
      { href: '/admin/pricing', label: 'Pricing & FX', icon: BadgeDollarSign },
    ],
  },
  {
    label: 'Records',
    items: [
      { href: '/admin/customers', label: 'Customers', icon: Users },
      {
        href: '/admin/domains',
        label: 'Domains',
        icon: Globe,
        badge: { count: (c) => c.drift, words: 'differ from the registry' },
      },
      { href: '/admin/ssl', label: 'Certificates', icon: ShieldCheck },
      {
        href: '/admin/emails',
        label: 'Emails',
        icon: Mail,
        badge: { count: (c) => c.emailsFailed, words: 'failed' },
      },
    ],
  },
  {
    label: 'Set-up',
    items: [
      {
        href: '/admin/settings',
        label: 'Settings',
        icon: Settings,
        badge: { count: (c) => c.presetDrafts, words: 'preset drafts open' },
      },
      { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
]

/** Every nav destination, for tests and the placeholders. */
export const ADMIN_NAV_HREFS = ADMIN_NAV.flatMap((group) => group.items.map((item) => item.href))
