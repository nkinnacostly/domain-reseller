'use client'

import { Menu, X } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { BRAND_NAME, Brand } from '@/components/layout/brand'
import { NavLink } from '@/components/layout/nav-link'
import { Container, PAGE_INSET } from '@/components/layout/site-shell'
import { Button } from '@/components/ui/button'
import { useSignedIn } from '@/features/auth/lib/use-signed-in'
import { CartLink } from '@/features/cart/components/cart-link'
import { cn } from '@/lib/utils'

const NAV = [
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/transfer', label: 'Transfer' },
  { href: '/ssl', label: 'SSL' },
] as const

/**
 * White on the blue hero, focus outlines included — the default ring does not
 * reach 3:1 against the blue (WCAG 1.4.11). The white pill hovers to the soft
 * white rather than fading, which would drop its blue text below 4.5:1.
 */
const LINK =
  'rounded-sm text-sm text-brand-muted-foreground hover:text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-foreground data-[current=true]:text-brand-foreground'
const ACCOUNT =
  'bg-brand-foreground text-brand hover:bg-brand-muted-foreground focus-visible:ring-brand-foreground/60'

/**
 * The site header. Every public page opens with the blue hero panel
 * (PageHero, or the home page's Hero), and the header floats over its top
 * edge. It is floated rather than nested so <header> stays a banner landmark
 * outside <main>, while the page's h1 sits inside main where it belongs.
 */
export function SiteHeader({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const account = useSignedIn()
    ? { href: '/app/domains', label: 'Your domains' }
    : { href: '/sign-in', label: 'Login' }

  return (
    <header className={cn('absolute inset-x-0 top-2 z-30 sm:top-4 lg:top-5', className)}>
      <Container className="flex items-center justify-between gap-2 py-5 sm:gap-4 sm:py-6">
        <Link
          href="/"
          aria-label={`${BRAND_NAME} home`}
          className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-foreground"
        >
          <Brand tone="onBrand" />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-9 md:flex">
          {NAV.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              className={LINK}
              // A 2px rule under the current link. Colour alone is not a
              // sufficient signal (WCAG 1.4.1).
              activeClassName="after:absolute after:-bottom-1.5 after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-brand-foreground"
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <CartLink />
          <Button
            asChild
            variant="secondary"
            className={cn('hidden rounded-full px-7 font-medium shadow-sm sm:inline-flex', ACCOUNT)}
          >
            <Link href={account.href}>{account.label}</Link>
          </Button>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="grid size-11 place-items-center rounded-full text-brand-foreground hover:bg-brand-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground md:hidden"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </Container>

      <div
        id="mobile-nav"
        hidden={!open}
        className={cn('border-brand-foreground/20 border-t bg-brand md:hidden', PAGE_INSET)}
      >
        {/* The panel is already inset by PAGE_INSET, so the gutter shrinks by
            as much to keep the links in line with the logo above them. */}
        <Container className="px-3 sm:px-4">
          <nav aria-label="Mobile" className="flex flex-col pb-4">
            {NAV.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn('py-3', LINK)}
                activeClassName="before:absolute before:top-1/2 before:-left-3 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-brand-foreground"
              >
                {item.label}
              </NavLink>
            ))}
            <Button asChild className={cn('mt-2 rounded-full', ACCOUNT)}>
              <Link href={account.href}>{account.label}</Link>
            </Button>
          </nav>
        </Container>
      </div>
    </header>
  )
}
