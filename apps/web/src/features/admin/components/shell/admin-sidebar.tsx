import { UserCog } from 'lucide-react'
import Link from 'next/link'
import { AccountMenu, MobileNav } from '@/components/layout/app-sidebar-client'
import { BRAND_NAME, Brand } from '@/components/layout/brand'
import { NavLink } from '@/components/layout/nav-link'
import { FOCUS } from '@/components/layout/panel'
import { ROLE_LABEL } from '@/features/admin/lib/labels'
import { type AttentionCounts, getAttentionCounts } from '@/features/admin/queries/attention'
import { findAdmin, getAdminSide } from '@/features/admin/queries/session'
import { getAccount } from '@/features/auth/queries/account'
import { initials } from '@/features/domains/lib/dashboard'
import { cn } from '@/lib/utils'
import { ADMIN_NAV } from './nav'

/**
 * The admin area's sidebar (ADMIN-SPEC §5.1): every page, grouped, with a
 * badge where something needs a person — its count read out with the link's
 * name. A drawer below `lg`. It renders beside AdminGate's explanations, so
 * a session SQL refuses gets the brand and the way out, not the pages.
 */

function SidebarContent({
  counts,
  name,
  email,
  role,
  showNav,
}: {
  counts: AttentionCounts | null
  name: string
  email: string
  role: string | null
  showNav: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/admin"
          aria-label={`${BRAND_NAME} admin — overview`}
          className={cn('w-fit rounded-full', FOCUS)}
        >
          <Brand />
        </Link>
        {role ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {role}
          </span>
        ) : null}
      </div>

      {showNav ? (
        <nav aria-label="Admin" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {ADMIN_NAV.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const count = item.badge && counts ? item.badge.count(counts) : 0
                  const Icon = item.icon
                  return (
                    <li key={item.href}>
                      <NavLink
                        href={item.href}
                        exact={item.exact}
                        className={cn(
                          'flex h-11 items-center gap-2.5 rounded-xl px-2.5 text-sm hover:bg-brand-subtle active:scale-[0.99]',
                          'data-[current=true]:bg-brand data-[current=true]:text-brand-foreground data-[current=true]:hover:bg-brand',
                          FOCUS,
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {count > 0 && item.badge ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="min-w-6 rounded-full bg-status-redemption/15 px-1.5 text-center text-xs font-medium text-foreground tabular-nums"
                            >
                              {count}
                            </span>
                            <span className="sr-only">
                              , {count} {item.badge.words}
                            </span>
                          </>
                        ) : null}
                      </NavLink>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      ) : (
        <div className="flex-1" />
      )}

      <div className="space-y-2">
        {/* An admin's account has no customer panel (proxy.ts): only its own settings. */}
        <Link
          href="/app/settings"
          className={cn(
            'flex h-11 items-center gap-2 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground transition hover:bg-brand-subtle active:scale-[0.99]',
            FOCUS,
          )}
        >
          <UserCog className="size-4 text-muted-foreground" aria-hidden="true" />
          Account settings
        </Link>
        <AccountMenu name={name} email={email} initials={initials(name, email)} />
      </div>
    </div>
  )
}

export async function AdminSidebar() {
  const [admin, account] = await Promise.all([findAdmin(), getAccount()])
  const side = admin ? await getAdminSide(admin) : 'live'
  const counts = admin ? await getAttentionCounts(side) : null
  const content = (
    <SidebarContent
      counts={counts}
      name={account?.fullName ?? ''}
      email={account?.email ?? ''}
      role={admin ? (ROLE_LABEL[admin.role] ?? admin.role) : null}
      showNav={admin !== null}
    />
  )

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-border border-b bg-background/95 px-4 py-2.5 sm:px-6 lg:hidden print:hidden">
        <Link
          href="/admin"
          aria-label={`${BRAND_NAME} admin — overview`}
          className={cn('rounded-full', FOCUS)}
        >
          <Brand />
        </Link>
        <MobileNav description="Pages in the admin area">{content}</MobileNav>
      </header>
      <aside
        aria-label="Admin panel"
        className="sticky top-4 hidden h-[calc(100dvh-2rem)] w-[17.5rem] shrink-0 rounded-3xl border border-brand-subtle-border bg-card/70 shadow-xs lg:block print:hidden"
      >
        {content}
      </aside>
    </>
  )
}

export function AdminSidebarSkeleton() {
  return (
    <div aria-hidden="true" className="contents">
      <div className="flex items-center justify-between border-border border-b bg-background/95 px-4 py-2.5 sm:px-6 lg:hidden">
        <Brand />
        <div className="size-11 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="sticky top-4 hidden h-[calc(100dvh-2rem)] w-[17.5rem] shrink-0 flex-col gap-3 rounded-3xl border border-brand-subtle-border bg-card/70 p-4 lg:flex">
        <Brand />
        {Array.from({ length: 10 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          <div key={index} className="h-9 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  )
}
