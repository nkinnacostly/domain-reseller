import {
  ArrowLeftRight,
  CalendarClock,
  ChevronDown,
  CircleHelp,
  FileText,
  LayoutDashboard,
  Mail,
  Receipt,
  Search,
  Settings,
  ShoppingCart,
  Tag,
} from 'lucide-react'
import Link from 'next/link'
import { BRAND_NAME, Brand } from '@/components/layout/brand'
import { NavLink } from '@/components/layout/nav-link'
import { getAccount } from '@/features/auth/queries/account'
import { CartLink } from '@/features/cart/components/cart-link'
import { initials, relativeDays, summarize } from '@/features/domains/lib/dashboard'
import { daysUntilExpiry, type PortfolioDomain } from '@/features/domains/lib/portfolio'
import { getPortfolio } from '@/features/domains/queries/domains'
import { cn } from '@/lib/utils'
import { AccountMenu, MobileNav } from './app-sidebar-client'

/**
 * The panel's sidebar (PRD §15.1): search, the panel's pages as tiles, the
 * domains due soonest, help, and the signed-in person. A drawer below `lg`.
 * Reads the session, so it renders inside Suspense.
 */

const TILES = [
  { href: '/app/domains', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/app/domains/expiring', label: 'Renewals', icon: CalendarClock },
  { href: '/app/orders', label: 'Orders', icon: Receipt },
  { href: '/cart', label: 'Cart', icon: ShoppingCart },
  { href: '/transfer', label: 'Transfer', icon: ArrowLeftRight },
  { href: '/app/settings', label: 'Settings', icon: Settings },
] as const

const HELP = [
  { href: '/help', label: 'Help centre', icon: CircleHelp },
  { href: '/pricing', label: 'Prices', icon: Tag },
  { href: '/contact', label: 'Contact us', icon: Mail },
  { href: '/legal/refunds', label: 'Refund policy', icon: FileText },
] as const

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="group">
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-1.5 rounded-lg py-1.5 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden',
          FOCUS,
        )}
      >
        <ChevronDown
          className="size-4 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0"
          aria-hidden="true"
        />
        {title}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  )
}

function dot(domain: PortfolioDomain, now: Date) {
  const days = daysUntilExpiry(domain.expiresAt, now) ?? Number.POSITIVE_INFINITY
  if (days < 0) return 'bg-status-expired'
  if (days <= 30) return 'bg-status-expiring'
  return 'bg-brand'
}

function SidebarContent({
  name,
  email,
  soonest,
  now,
}: {
  name: string
  email: string
  soonest: PortfolioDomain[]
  now: Date
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-5 p-4">
      <Link
        href="/app/domains"
        aria-label={`${BRAND_NAME} — your dashboard`}
        className={cn('w-fit rounded-full', FOCUS)}
      >
        <Brand />
      </Link>

      <search>
        <form action="/search" method="get">
          <label className="flex h-11 items-center gap-2.5 border-border border-b px-1 text-sm focus-within:border-ring">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Find a new domain</span>
            <input
              name="q"
              type="search"
              required
              maxLength={253}
              placeholder="Find a new domain"
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            />
          </label>
        </form>
      </search>

      <nav aria-label="Account">
        <ul className="grid grid-cols-2 gap-2">
          {TILES.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <NavLink
                href={href}
                className={cn(
                  'flex h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-background/70 text-sm hover:border-brand-subtle-border hover:bg-brand-subtle active:scale-[0.98]',
                  'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground data-[current=true]:hover:bg-brand',
                  FOCUS,
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
        <Section title="Renew soonest">
          {soonest.length > 0 ? (
            <ul className="space-y-0.5">
              {soonest.map((domain) => (
                <li key={domain.id}>
                  <Link
                    href={`/app/domains/${domain.domainName}`}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg py-1.5 pr-1 pl-1.5 text-sm text-muted-foreground hover:bg-brand-subtle hover:text-foreground',
                      FOCUS,
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn('size-2 shrink-0 rounded-[3px]', dot(domain, now))}
                    />
                    <span className="min-w-0 flex-1 truncate">{domain.domainName}</span>
                    <span className="shrink-0 text-xs tabular-nums">
                      {relativeDays(domain.expiresAt as string, now)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-1.5 pl-1.5 text-sm text-muted-foreground">Nothing to renew yet.</p>
          )}
        </Section>

        <Section title="Help">
          <ul className="space-y-1.5">
            {HELP.map(({ href, label, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  className={cn(
                    'flex h-9 items-center gap-2.5 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground hover:bg-brand-subtle',
                    FOCUS,
                  )}
                >
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="flex items-center gap-2">
        <AccountMenu name={name} email={email} initials={initials(name, email)} />
        <CartLink tone="default" className="rounded-2xl" />
      </div>
    </div>
  )
}

export async function AppSidebar() {
  const [account, domains] = await Promise.all([getAccount(), getPortfolio()])
  const now = new Date()
  const content = (
    <SidebarContent
      name={account?.fullName ?? ''}
      email={account?.email ?? ''}
      soonest={summarize(domains, [], now).upcoming.slice(0, 4)}
      now={now}
    />
  )

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-border border-b bg-background/95 px-4 py-2.5 sm:px-6 lg:hidden">
        <Link
          href="/app/domains"
          aria-label={`${BRAND_NAME} — your dashboard`}
          className={cn('rounded-full', FOCUS)}
        >
          <Brand />
        </Link>
        <div className="flex items-center gap-2">
          <CartLink tone="default" />
          <MobileNav>{content}</MobileNav>
        </div>
      </header>
      <aside
        aria-label="Panel"
        className="sticky top-4 hidden h-[calc(100dvh-2rem)] w-[17.5rem] shrink-0 rounded-3xl border border-brand-subtle-border bg-card/70 shadow-xs lg:block"
      >
        {content}
      </aside>
    </>
  )
}

export function AppSidebarSkeleton() {
  return (
    <div aria-hidden="true" className="contents">
      <div className="flex items-center justify-between border-border border-b bg-background/95 px-4 py-2.5 sm:px-6 lg:hidden">
        <Brand />
        <div className="size-11 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="sticky top-4 hidden h-[calc(100dvh-2rem)] w-[17.5rem] shrink-0 flex-col gap-5 rounded-3xl border border-brand-subtle-border bg-card/70 p-4 lg:flex">
        <Brand />
        <div className="h-11 animate-pulse rounded-xl bg-muted" />
        <div className="grid grid-cols-2 gap-2">
          {TILES.map((tile) => (
            <div key={tile.href} className="h-[4.5rem] animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      </div>
    </div>
  )
}
