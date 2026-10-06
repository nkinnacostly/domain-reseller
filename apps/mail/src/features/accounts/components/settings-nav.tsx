'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isCurrentPath } from '@/components/layout/nav-link'
import { SECURITY_PAGE } from '@/features/auth/lib/links'
import { cn } from '@/lib/utils'

/**
 * Settings' sections (MAIL-SPEC §10): the account's profile, its members, its
 * log, and your own security. Tabs that are pages: the current one carries
 * `aria-current="page"` and a thick underline, not colour alone (S13).
 */
export const SETTINGS_NAV = [
  { href: '/dashboard/settings', label: 'Profile', exact: true },
  { href: '/dashboard/settings/members', label: 'Members', exact: false },
  { href: '/dashboard/settings/log', label: 'Account log', exact: false },
  { href: SECURITY_PAGE, label: 'Your security', exact: false },
] as const

export function SettingsNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Settings" className="relative -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-border px-1">
        {SETTINGS_NAV.map((item) => {
          const current = isCurrentPath(item.href, pathname, item.exact)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                data-current={current ? 'true' : undefined}
                className={cn(
                  '-mb-px inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm text-muted-foreground transition-colors',
                  'hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
                  'data-[current=true]:border-primary data-[current=true]:font-semibold data-[current=true]:text-foreground',
                )}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
