import { Search } from 'lucide-react'
import Link from 'next/link'
import { BRAND_NAME, Brand } from '@/components/layout/brand'
import { NavLink } from '@/components/layout/nav-link'
import { BrandPanel } from '@/components/layout/page-hero'
import { Container } from '@/components/layout/site-shell'
import { SignOutButton } from '@/features/auth/components/sign-out-button'
import { getAccount } from '@/features/auth/queries/account'
import { CartLink } from '@/features/cart/components/cart-link'
import { cn } from '@/lib/utils'

const NAV = [
  { href: '/app/domains', label: 'Domains' },
  { href: '/app/orders', label: 'Orders' },
  { href: '/app/settings', label: 'Settings' },
] as const

/** White on the blue bar, focus outlines included (WCAG 1.4.11). */
const LINK =
  'rounded-sm py-2 text-sm text-brand-muted-foreground hover:text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-foreground data-[current=true]:text-brand-foreground'

/**
 * The panel header: the blue panel from the public pages, as a bar. Reads the
 * session, so it renders inside Suspense.
 */
export async function AppHeader() {
  const account = await getAccount()

  return (
    <header>
      <BrandPanel>
        <Container className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4 sm:py-5">
          <Link
            href="/app/domains"
            aria-label={`${BRAND_NAME} — your domains`}
            className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-foreground"
          >
            <Brand tone="onBrand" />
          </Link>

          <nav
            aria-label="Account"
            className="order-3 flex w-full items-center gap-6 sm:order-none sm:w-auto"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                className={LINK}
                activeClassName="after:absolute after:-bottom-0.5 after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-brand-foreground"
              >
                {item.label}
              </NavLink>
            ))}
            <Link href="/search" className={cn('inline-flex items-center gap-1.5', LINK)}>
              <Search className="size-4" aria-hidden="true" />
              <span className="sm:hidden">Search</span>
              <span className="hidden sm:inline">Search domains</span>
            </Link>
          </nav>

          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <CartLink />
            {account ? (
              <span className="hidden max-w-[16rem] truncate text-sm text-brand-muted-foreground md:inline">
                {account.email}
              </span>
            ) : null}
            <SignOutButton className="border-transparent bg-brand-foreground text-brand hover:bg-brand-muted-foreground focus-visible:outline-brand-foreground" />
          </div>
        </Container>
      </BrandPanel>
    </header>
  )
}

export function AppHeaderSkeleton() {
  return (
    <div aria-hidden="true">
      <BrandPanel>
        <Container className="relative flex items-center justify-between py-4 sm:py-5">
          <Brand tone="onBrand" />
          <div className="h-10 w-28 animate-pulse rounded-full bg-brand-foreground/20" />
        </Container>
      </BrandPanel>
    </div>
  )
}
