'use client'

import { Menu, X } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { Brand } from '@/components/layout/brand'
import { NavLink } from '@/components/layout/nav-link'
import { Container } from '@/components/layout/site-shell'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const NAV = [
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/transfer', label: 'Transfer' },
] as const

export function SiteHeader({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)

  return (
    <header className={cn('relative z-30', className)}>
      <Container className="flex items-center justify-between gap-4 py-5 sm:py-6">
        <Link href="/" aria-label={`${'Naijadomains'} home`}>
          <Brand />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-9 md:flex">
          {NAV.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              className="text-sm"
              // A 2px rule under the current link. Colour alone is not a
              // sufficient signal (WCAG 1.4.1).
              activeClassName="after:absolute after:-bottom-1.5 after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-accent"
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Button
            asChild
            variant="secondary"
            className="hidden rounded-full bg-background px-7 font-medium shadow-sm hover:bg-background/90 sm:inline-flex"
          >
            <Link href="/sign-in">Login</Link>
          </Button>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="grid size-11 place-items-center rounded-full text-foreground md:hidden"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </Container>

      <div
        id="mobile-nav"
        hidden={!open}
        className="border-border/60 border-t bg-hero-from md:hidden"
      >
        <Container>
          <nav aria-label="Mobile" className="flex flex-col pb-4">
            {NAV.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="py-3 text-sm"
                activeClassName="before:absolute before:top-1/2 before:-left-3 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-accent"
              >
                {item.label}
              </NavLink>
            ))}
            <Button asChild className="mt-2 rounded-full">
              <Link href="/sign-in">Login</Link>
            </Button>
          </nav>
        </Container>
      </div>
    </header>
  )
}
