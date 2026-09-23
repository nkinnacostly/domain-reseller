'use client'

import { NavLink } from '@/components/layout/nav-link'

/** FR-P6 — the domain's tabs, each its own page so the URL says where you are. */
export function DomainTabs({ domain }: { domain: string }) {
  const base = `/app/domains/${domain}`
  const tabs = [
    { href: base, label: 'Overview', exact: true },
    { href: `${base}/nameservers`, label: 'Nameservers' },
    { href: `${base}/contacts`, label: 'Contacts' },
    { href: `${base}/security`, label: 'Security' },
    { href: `${base}/activity`, label: 'Activity' },
  ]
  return (
    <nav aria-label="Domain" className="relative -mx-1 overflow-x-auto border-border border-b">
      <ul className="flex min-w-max gap-6 px-1">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <NavLink
              href={tab.href}
              exact={tab.exact}
              className="inline-block py-3 text-sm"
              activeClassName="after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-accent"
            >
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
