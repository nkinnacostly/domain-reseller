'use client'

import { NavLink } from '@/components/layout/nav-link'

export type RouteTab = { href: string; label: string; exact?: boolean; count?: number }

/** Tabs that are pages: the URL says which is open, and the current one is marked (S13). */
export function RouteTabs({ label, tabs }: { label: string; tabs: RouteTab[] }) {
  return (
    <nav aria-label={label} className="relative -mx-1 overflow-x-auto px-1 py-1">
      <ul className="flex min-w-max gap-2">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <NavLink
              href={tab.href}
              exact={tab.exact}
              className="inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm hover:bg-brand-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground"
            >
              {tab.count !== undefined ? `${tab.label} (${tab.count})` : tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
