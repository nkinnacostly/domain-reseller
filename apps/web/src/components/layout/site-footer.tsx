import Link from 'next/link'
import { connection } from 'next/server'
import { Suspense } from 'react'
import { BRAND_NAME, Brand } from '@/components/layout/brand'
import { NavLink } from '@/components/layout/nav-link'
import { Container } from '@/components/layout/site-shell'
import { BUSINESS, SPONSORING_REGISTRAR } from '@/lib/business'

/**
 * The footer is a compliance surface, not decoration (PRD §7.1).
 *
 *  • CMP-2 — the Registrants' Benefits and Responsibilities Specification must
 *    be published or linked.
 *  • CMP-3 — we must NEVER display the ICANN logo or describe ourselves as
 *    ICANN-accredited. We are an authorised reseller of an accredited registrar.
 *  • CMP-4 — an abuse contact must be published.
 *  • CMP-5 — the UDRP and transfer dispute policy must be linked.
 */
const COLUMNS = [
  {
    heading: 'Domains',
    links: [
      { href: '/search', label: 'Search' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/transfer', label: 'Transfer in' },
    ],
  },
  {
    heading: 'Extensions',
    links: [
      { href: '/domains/com', label: '.com' },
      { href: '/domains/net', label: '.net' },
      { href: '/domains/org', label: '.org' },
      { href: '/domains/africa', label: '.africa' },
    ],
  },
  {
    heading: 'Support',
    links: [
      { href: '/help', label: 'Help centre' },
      { href: '/contact', label: 'Contact us' },
      { href: '/abuse', label: 'Report abuse' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/legal/registration-agreement', label: 'Registration agreement' },
      { href: '/legal/registrant-rights', label: "Registrants' rights" },
      { href: '/legal/privacy', label: 'Privacy notice' },
      { href: '/legal/refunds', label: 'Refund policy' },
      { href: '/legal', label: 'All legal documents' },
    ],
  },
] as const

/**
 * Reading the clock is request-time data. Under Cache Components a bare
 * `new Date()` during render aborts the static shell, so this awaits
 * `connection()` to mark itself dynamic and renders inside a Suspense
 * boundary — the rest of the footer still prerenders.
 */
const LAUNCH_YEAR = 2026

async function CopyrightYear() {
  await connection()
  const year = new Date().getFullYear()
  return <>{year > LAUNCH_YEAR ? `${LAUNCH_YEAR}–${year}` : LAUNCH_YEAR}</>
}

export function SiteFooter() {
  return (
    <footer className="border-border border-t bg-muted/40">
      <Container className="py-12 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_3fr] lg:gap-16">
          <div className="max-w-xs">
            <Brand />
            <p className="mt-4 text-pretty text-sm/6 text-muted-foreground">
              Domain registration for Nigeria. Naira pricing, renewal costs shown upfront, and a
              domain that stays yours.
            </p>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            {COLUMNS.map((column) => (
              <div key={column.heading}>
                <h2 className="text-sm font-semibold text-foreground">{column.heading}</h2>
                <ul className="mt-4 space-y-3">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <NavLink href={link.href} className="text-sm hover:underline">
                        {link.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="border-border/70 mt-12 border-t pt-8">
          <p className="max-w-3xl text-pretty text-xs/5 text-muted-foreground">
            {/* CMP-1 / CMP-3 — name the sponsoring registrar; never claim accreditation
                ourselves. The registrar is verified for .com only (lib/business.ts). */}
            {BRAND_NAME} is operated by {BUSINESS.operator}, an authorised reseller — not itself
            ICANN-accredited. .com registrations are sponsored by {SPONSORING_REGISTRAR.name}, an
            ICANN-accredited registrar; every domain&apos;s registrar is named in its public
            registration record. Your rights and responsibilities as a registrant are set out in the{' '}
            <Link href="/legal/registrant-rights" className="underline hover:text-foreground">
              Registrants&apos; Benefits and Responsibilities Specification
            </Link>
            . Disputes are handled under the{' '}
            <Link href="/legal/udrp" className="underline hover:text-foreground">
              Uniform Domain-Name Dispute-Resolution Policy
            </Link>{' '}
            and the{' '}
            <Link href="/legal/transfer-disputes" className="underline hover:text-foreground">
              Transfer Dispute Resolution Policy
            </Link>
            .
          </p>

          <div className="mt-6 flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>
              ©{' '}
              <Suspense fallback={LAUNCH_YEAR}>
                <CopyrightYear />
              </Suspense>{' '}
              {BUSINESS.operator}, trading as {BRAND_NAME}. All rights reserved.
            </p>
            <p>
              Abuse reports:{' '}
              <a href={`mailto:${BUSINESS.email}`} className="underline hover:text-foreground">
                {BUSINESS.email}
              </a>
            </p>
          </div>
        </div>
      </Container>
    </footer>
  )
}
