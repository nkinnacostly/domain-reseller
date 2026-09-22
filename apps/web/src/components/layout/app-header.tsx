import { Search } from 'lucide-react'
import Link from 'next/link'
import { Brand } from '@/components/layout/brand'
import { NavLink } from '@/components/layout/nav-link'
import { Container } from '@/components/layout/site-shell'
import { SignOutButton } from '@/features/auth/components/sign-out-button'
import { getAccount } from '@/features/auth/queries/account'
import { CartLink } from '@/features/cart/components/cart-link'

const NAV = [
  { href: '/app/domains', label: 'Domains' },
  { href: '/app/orders', label: 'Orders' },
  { href: '/app/settings', label: 'Settings' },
] as const

/** The panel header. Reads the session, so it renders inside Suspense. */
export async function AppHeader() {
  const account = await getAccount()

  return (
    <header className="border-border/60 border-b">
      <Container className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4 sm:py-5">
        <Link href="/app/domains" aria-label="Naijadomains — your domains">
          <Brand />
        </Link>

        <nav
          aria-label="Account"
          className="order-3 flex w-full items-center gap-6 sm:order-none sm:w-auto"
        >
          {NAV.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              className="py-2 text-sm"
              activeClassName="after:absolute after:-bottom-0.5 after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-accent"
            >
              {item.label}
            </NavLink>
          ))}
          <Link
            href="/search"
            className="inline-flex items-center gap-1.5 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Search className="size-4" aria-hidden="true" />
            <span className="sm:hidden">Search</span>
            <span className="hidden sm:inline">Search domains</span>
          </Link>
        </nav>

        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <CartLink />
          {account ? (
            <span className="hidden max-w-[16rem] truncate text-sm text-muted-foreground md:inline">
              {account.email}
            </span>
          ) : null}
          <SignOutButton />
        </div>
      </Container>
    </header>
  )
}

export function AppHeaderSkeleton() {
  return (
    <div aria-hidden="true" className="border-border/60 border-b">
      <Container className="flex items-center justify-between py-4 sm:py-5">
        <Brand />
        <div className="h-10 w-28 animate-pulse rounded-full bg-muted" />
      </Container>
    </div>
  )
}
