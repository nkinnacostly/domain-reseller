'use client'

import { ExternalLink, Menu } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Brand, PRODUCT_NAME } from '@/components/layout/brand'
import { isCurrentPath } from '@/components/layout/nav-link'
import { ThemeToggle } from '@/components/layout/theme-toggle'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { SignOutButton } from '@/features/auth/components/sign-out-button'
import { BUSINESS } from '@/lib/business'
import { cn } from '@/lib/utils'
import { ADMIN_NAV } from './nav'

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** The admin's pages (S13): the current one carries aria-current, a bar and weight. */
function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Admin" className="flex-1">
      <ul className="space-y-1">
        {ADMIN_NAV.map((item) => {
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
                  FOCUS,
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

function SidebarBody({
  roleLabel,
  showNav,
  onNavigate,
}: {
  roleLabel: string | null
  showNav: boolean
  onNavigate?: () => void
}) {
  return (
    <div className="flex h-full flex-col gap-5">
      {roleLabel ? (
        <p className="px-3 text-xs text-muted-foreground">
          Signed in as an admin: <span className="font-medium text-foreground">{roleLabel}</span>
        </p>
      ) : null}
      {showNav ? <AdminNav onNavigate={onNavigate} /> : <div className="flex-1" />}
      <div className="space-y-1 border-t border-border pt-4">
        {/* An admin's account is admin-only: its password and two-factor are the shop's (one sign-in, M5). */}
        <a
          href={`${BUSINESS.shopUrl}/app/settings`}
          className={cn(
            'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98]',
            FOCUS,
          )}
        >
          <ExternalLink className="size-4" aria-hidden="true" />
          Password and two-factor
          <span className="sr-only">, in the domain shop’s account settings</span>
        </a>
        <div className="flex items-center justify-between gap-2">
          <SignOutButton variant="menu" className="min-h-11 flex-1 px-3" />
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}

/**
 * Mail's admin shell (MAIL-SPEC §10): a sidebar from `lg`, a top bar with a
 * drawer below it, as the dashboard's. It renders beside the gate's
 * explanations, so a session SQL refuses gets the brand and the way out, not
 * the pages (`showNav`).
 */
export function AdminFrame({
  roleLabel,
  showNav,
  children,
}: {
  roleLabel: string | null
  showNav: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside
        aria-label="Admin panel"
        className="hidden border-r border-border bg-card lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-72 lg:shrink-0 lg:flex-col lg:gap-6 lg:overflow-y-auto lg:px-4 lg:py-5"
      >
        <Link
          href="/admin"
          aria-label={`${PRODUCT_NAME} admin, overview`}
          className={cn('self-start rounded-md px-2', FOCUS)}
        >
          <Brand />
        </Link>
        <SidebarBody roleLabel={roleLabel} showNav={showNav} />
      </aside>

      <header className="sticky top-0 z-30 border-b border-border bg-background lg:hidden">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-5 sm:px-8">
          <Link
            href="/admin"
            aria-label={`${PRODUCT_NAME} admin, overview`}
            className={cn('rounded-md', FOCUS)}
          >
            <Brand compact />
          </Link>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant="outline" className="min-h-11 gap-2 rounded-full px-4">
                <Menu aria-hidden="true" />
                <span>Menu</span>
                <span className="sr-only">, open the admin menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[min(20rem,85vw)] overflow-y-auto px-4 pb-6">
              <SheetHeader className="px-0 pb-0">
                <SheetTitle>Admin menu</SheetTitle>
                <SheetDescription className="sr-only">
                  The admin area’s pages, and your sign-in.
                </SheetDescription>
              </SheetHeader>
              <SidebarBody
                roleLabel={roleLabel}
                showNav={showNav}
                onNavigate={() => setOpen(false)}
              />
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <main id="main" className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  )
}
