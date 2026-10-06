'use client'

import { Menu, Moon, Sun, X } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useState } from 'react'
import { Brand, PRODUCT_NAME } from '@/components/layout/brand'
import { Container } from '@/components/layout/container'
import { NavLink } from '@/components/layout/nav-link'
import { cn } from '@/lib/utils'
import { HEADER_NAV, ROUTES } from '../lib/site'
import { PANEL_INSET } from './page-hero'

/**
 * White on the blue panel, focus outlines included: the default ring does
 * not reach 3:1 against the blue (WCAG 1.4.11). The current page keeps
 * NavLink's underline beside the colour (S13).
 */
const LINK =
  'rounded-sm text-sm text-brand-muted-foreground hover:text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-foreground data-[current=true]:text-brand-foreground'

/** The white pill on blue. Hovers to the soft white, never fades: its blue text keeps 4.5:1. */
const PILL =
  'inline-flex min-h-11 items-center justify-center rounded-full bg-brand-foreground px-6 text-sm font-medium text-brand shadow-sm transition-colors hover:bg-brand-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground active:scale-[0.98]'

const ROUND =
  'grid size-11 place-items-center rounded-full text-brand-foreground transition-colors hover:bg-brand-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground active:bg-brand-foreground/20'

/**
 * Light or dark (S3), drawn for the blue panel. Both icons are rendered and
 * CSS shows the right one, so the server render and the first client render
 * agree before the theme is known. The label names what a press does.
 */
function ThemeToggleOnBrand() {
  const { resolvedTheme, setTheme } = useTheme()
  const next = resolvedTheme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className={ROUND}
      aria-label={`Use the ${next} theme`}
      onClick={() => setTheme(next)}
    >
      <Sun aria-hidden="true" className="hidden size-5 dark:block" />
      <Moon aria-hidden="true" className="block size-5 dark:hidden" />
    </button>
  )
}

/**
 * The public pages' header. Every public page opens with the blue panel,
 * and the header floats over its top edge (CLAUDE.md §15): floated rather
 * than nested, so <header> stays a banner landmark outside <main> while the
 * page's h1 sits inside it. Same Container as every section (S4).
 */
export function MarketingHeader() {
  // The menu is open for the page it was opened on, so following a link in
  // it closes it without an effect.
  const pathname = usePathname()
  const [openOn, setOpenOn] = useState<string | null>(null)
  const open = openOn === pathname
  const close = () => setOpenOn(null)

  return (
    <header className="absolute inset-x-0 top-2 z-30 sm:top-4 lg:top-5">
      <Container className="flex items-center justify-between gap-2 py-5 sm:gap-4 sm:py-6">
        <Link
          href={ROUTES.home}
          aria-label={`${PRODUCT_NAME}, home`}
          className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-foreground"
        >
          <Brand tone="onBrand" compact />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-9 md:flex">
          {HEADER_NAV.map((item) => (
            <NavLink key={item.href} href={item.href} className={LINK}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-1 sm:gap-2">
          <NavLink
            href={ROUTES.signIn}
            className={cn('hidden min-h-11 items-center px-3 md:inline-flex', LINK)}
          >
            Sign in
          </NavLink>
          <Link href={ROUTES.signUp} className={cn(PILL, 'hidden sm:inline-flex')}>
            Get started
          </Link>
          <ThemeToggleOnBrand />
          <button
            type="button"
            onClick={() => setOpenOn(open ? null : pathname)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            className={cn(ROUND, 'md:hidden')}
          >
            {open ? (
              <X aria-hidden="true" className="size-5" />
            ) : (
              <Menu aria-hidden="true" className="size-5" />
            )}
          </button>
        </div>
      </Container>

      <div
        id="mobile-nav"
        hidden={!open}
        className={cn('border-t border-brand-foreground/20 bg-brand md:hidden', PANEL_INSET)}
      >
        {/* The panel is already inset, so the gutter shrinks by as much to
            keep the links in line with the logo above them. */}
        <Container className="px-3 sm:px-4">
          <nav aria-label="Mobile" className="flex flex-col pb-4">
            {[...HEADER_NAV, { href: ROUTES.signIn, label: 'Sign in' }].map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                className={cn('inline-flex min-h-11 items-center', LINK)}
              >
                {item.label}
              </NavLink>
            ))}
            <Link href={ROUTES.signUp} onClick={close} className={cn('mt-2', PILL)}>
              Get started
            </Link>
          </nav>
        </Container>
      </div>
    </header>
  )
}
