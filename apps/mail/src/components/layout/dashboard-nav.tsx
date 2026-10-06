'use client'

import {
  Ban,
  CreditCard,
  Globe,
  KeyRound,
  LayoutDashboard,
  Mail,
  Settings,
  Webhook,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { isCurrentPath } from './nav-link'

/**
 * The dashboard's pages (MAIL-SPEC §10), in the spec's order. Each exists:
 * the ones a later package fills say so on the page itself (N9b).
 */
export const DASHBOARD_NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/emails', label: 'Emails', icon: Mail, exact: false },
  { href: '/dashboard/domains', label: 'Domains', icon: Globe, exact: false },
  { href: '/dashboard/api-keys', label: 'API keys', icon: KeyRound, exact: false },
  { href: '/dashboard/webhooks', label: 'Webhooks', icon: Webhook, exact: false },
  { href: '/dashboard/suppressions', label: 'Suppressions', icon: Ban, exact: false },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard, exact: false },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, exact: false },
] as const

/**
 * The sidebar's links (S13): the current page carries `aria-current="page"`,
 * a bar at its edge and a heavier weight — never colour alone. Active colours
 * go through `data-[current=true]:`, as in the shop.
 */
export function DashboardNav({
  onNavigate,
  className,
}: {
  /** Closes the mobile drawer once a page is chosen. */
  onNavigate?: () => void
  className?: string
}) {
  const pathname = usePathname()
  return (
    <nav aria-label="Dashboard" className={className}>
      <ul className="space-y-1">
        {DASHBOARD_NAV.map((item) => {
          const current = isCurrentPath(item.href, pathname, item.exact)
          const Icon = item.icon
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={current ? 'page' : undefined}
                data-current={current ? 'true' : undefined}
                className={cn(
                  'relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground active:scale-[0.98]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  'data-[current=true]:bg-muted data-[current=true]:font-semibold data-[current=true]:text-foreground',
                  'data-[current=true]:before:absolute data-[current=true]:before:inset-y-2 data-[current=true]:before:left-0 data-[current=true]:before:w-1 data-[current=true]:before:rounded-full data-[current=true]:before:bg-primary',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
