import Link from 'next/link'
import { Brand, PRODUCT_NAME } from './brand'
import { Container } from './container'
import { NavLink } from './nav-link'
import { ThemeToggle } from './theme-toggle'

/** Pages that exist today; each later package adds its own (N9b: no link to nothing). */
export const NAV = [{ href: '/dashboard', label: 'Dashboard' }] as const

export function SiteHeader() {
  return (
    <header className="border-b border-border bg-background">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          aria-label={`${PRODUCT_NAME}, home`}
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <Brand compact />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 sm:gap-3">
          {NAV.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              className="inline-flex min-h-11 items-center px-3"
            >
              {item.label}
            </NavLink>
          ))}
          <ThemeToggle />
        </nav>
      </Container>
    </header>
  )
}
