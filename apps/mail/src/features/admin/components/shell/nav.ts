import { Activity, Globe, LayoutDashboard, ListChecks, ScrollText, Users } from 'lucide-react'

/** Every page of Mail's admin (MAIL-SPEC §10), in the sidebar's order. */
export const ADMIN_NAV = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/admin/review', label: 'Review queue', icon: ListChecks, exact: false },
  { href: '/admin/accounts', label: 'Accounts', icon: Users, exact: false },
  { href: '/admin/domains', label: 'Domains', icon: Globe, exact: false },
  { href: '/admin/health', label: 'SES health', icon: Activity, exact: false },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText, exact: false },
] as const

export const ADMIN_NAV_HREFS = ADMIN_NAV.map((item) => item.href)
