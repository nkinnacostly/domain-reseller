import { connection } from 'next/server'
import { Suspense } from 'react'
import { BRAND_NAME, Brand } from '@/components/layout/brand'
import { Container } from '@/components/layout/container'
import { NavLink } from '@/components/layout/nav-link'
import { LEGAL_DOCUMENTS } from '@/features/legal/lib/documents'
import { BUSINESS } from '@/lib/business'
import { ROUTES } from '../lib/site'

export const FOOTER_COLUMNS = [
  {
    heading: 'Product',
    links: [
      { href: ROUTES.pricing, label: 'Pricing' },
      { href: ROUTES.docs, label: 'Docs' },
      { href: ROUTES.signUp, label: 'Get started' },
      { href: ROUTES.signIn, label: 'Sign in' },
      // The shop, MyDomainsHub's other product: a domain to send from.
      { href: BUSINESS.shopUrl, label: 'Buy a domain name' },
    ],
  },
  {
    heading: 'Support',
    links: [
      { href: ROUTES.contact, label: 'Contact us' },
      { href: ROUTES.abuse, label: 'Report abuse' },
    ],
  },
  {
    heading: 'Legal',
    links: LEGAL_DOCUMENTS.map((document) => ({ href: document.href, label: document.title })),
  },
] as const

/**
 * Reading the clock is request-time data: under Cache Components a bare
 * `new Date()` aborts the static shell, so the year awaits `connection()`
 * inside Suspense and the rest of the footer still prerenders.
 */
export const LAUNCH_YEAR = 2026

export async function CopyrightYear() {
  await connection()
  const year = new Date().getFullYear()
  return <>{year > LAUNCH_YEAR ? `${LAUNCH_YEAR}–${year}` : LAUNCH_YEAR}</>
}

/** Set rather than inherited: NavLink brings its own muted and hover colours. */
const LINK =
  'rounded-sm text-sm text-footer-muted-foreground hover:text-footer-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-footer-foreground data-[current=true]:text-footer-foreground'
const INLINE =
  'rounded-sm underline underline-offset-4 hover:text-footer-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-footer-foreground'

/**
 * The public pages' footer: the operator, as the shop names it, and every
 * public page. `year` replaces the live year (tests render it without a
 * request).
 */
export function MarketingFooter({
  year = (
    <Suspense fallback={LAUNCH_YEAR}>
      <CopyrightYear />
    </Suspense>
  ),
}: {
  year?: React.ReactNode
}) {
  return (
    <footer className="bg-footer text-footer-foreground">
      <Container className="py-12 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_3fr] lg:gap-16">
          <div className="max-w-xs">
            <Brand tone="onFooter" />
            <p className="mt-4 text-pretty text-sm/6 text-footer-muted-foreground">
              Transactional email for Nigerian businesses, priced in naira. A{' '}
              <a href={BUSINESS.shopUrl} className={INLINE}>
                {BRAND_NAME}
              </a>{' '}
              product.
            </p>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {FOOTER_COLUMNS.map((column) => (
              <div key={column.heading}>
                <h2 className="text-sm font-semibold text-footer-foreground">{column.heading}</h2>
                <ul className="mt-4 space-y-3">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <NavLink href={link.href} className={LINK}>
                        {link.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-footer-border pt-8 text-xs/5 text-footer-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {BUSINESS.operator} ({BUSINESS.rcNumber}), trading as {BRAND_NAME}. All rights
            reserved.
          </p>
          <p>
            Abuse reports:{' '}
            <a href={`mailto:${BUSINESS.email}`} className={INLINE}>
              {BUSINESS.email}
            </a>
          </p>
        </div>
      </Container>
    </footer>
  )
}
