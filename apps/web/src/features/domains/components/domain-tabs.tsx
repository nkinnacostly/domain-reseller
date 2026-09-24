'use client'

import { NavLink } from '@/components/layout/nav-link'

/** FR-P6 — the domain's tabs, each its own page so the URL says where you are. */
export function DomainTabs({ domain }: { domain: string }) {
  const base = `/app/domains/${domain}`
  const tabs = [
    { href: base, label: 'Overview', exact: true },
    { href: `${base}/renew`, label: 'Renew' },
    { href: `${base}/nameservers`, label: 'Nameservers' },
    { href: `${base}/contacts`, label: 'Contacts' },
    { href: `${base}/security`, label: 'Security' },
    { href: `${base}/activity`, label: 'Activity' },
  ]
  return (
    <nav aria-label="Domain" className="relative -mx-1 overflow-x-auto px-1 py-1">
      <ul className="flex min-w-max gap-2">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <NavLink
              href={tab.href}
              exact={tab.exact}
              className="inline-flex h-10 items-center rounded-full border border-border bg-background px-4 text-sm hover:bg-brand-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground"
            >
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
