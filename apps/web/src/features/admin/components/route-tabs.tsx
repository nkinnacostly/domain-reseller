'use client'

import { Check } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { isCurrentPath, NavLink } from '@/components/layout/nav-link'

export type RouteTab = {
  href: string
  label: string
  exact?: boolean
  count?: number
  /**
   * For tabs that share one path and differ by their query (`?tab=`): the
   * page says which is open. Unset, the path decides.
   */
  current?: boolean
}

/**
 * Tabs that are pages: the URL says which is open, and the current one
 * carries `aria-current="page"`, a tick and heavier words — never colour
 * alone (S13). Only the press animates: a tab's colours change at once, so
 * nothing (axe included) reads a half-way colour after a click.
 */
export function RouteTabs({ label, tabs }: { label: string; tabs: RouteTab[] }) {
  const pathname = usePathname()
  return (
    <nav aria-label={label} className="relative -mx-1 overflow-x-auto px-1 py-1">
      <ul className="flex min-w-max gap-2">
        {tabs.map((tab) => {
          const current = tab.current ?? isCurrentPath(tab.href, pathname, tab.exact)
          return (
            <li key={tab.href}>
              <NavLink
                href={tab.href}
                current={current}
                className="inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm transition-transform hover:bg-brand-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground"
              >
                {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {tab.count !== undefined ? `${tab.label} (${tab.count})` : tab.label}
              </NavLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
