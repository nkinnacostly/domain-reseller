import { ArrowRight, ShieldCheck } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { Container } from '@/components/layout/site-shell'
import { getAccount } from '@/features/auth/queries/account'
import { Portfolio } from '@/features/domains/components/portfolio'
import { parseExpiryWindow } from '@/features/domains/lib/portfolio'
import { getPortfolio } from '@/features/domains/queries/domains'

export const metadata: Metadata = { title: 'Your domains' }

/**
 * Portfolio — the authenticated landing page (PRD FR-P1): every domain on the
 * account, soonest expiry first, with the expiry view as a filter (FR-P5).
 */
type Search = Promise<{ q?: string; within?: string }>

async function PortfolioPage({ searchParams }: { searchParams: Search }) {
  const [account, domains, params] = await Promise.all([getAccount(), getPortfolio(), searchParams])
  const firstName = account?.fullName.split(' ')[0]

  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        {firstName ? `Welcome, ${firstName}` : 'Your domains'}
      </h1>

      {account && !account.totpFactor ? (
        <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-border bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden="true" />
            <div>
              <p className="font-medium text-foreground">Protect your account with two-factor</p>
              <p className="mt-1 text-pretty text-sm text-muted-foreground">
                With it on, a stolen password alone can't take your domains.
              </p>
            </div>
          </div>
          <Link
            href="/app/settings#two-factor"
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            Turn it on
          </Link>
        </div>
      ) : null}

      {domains.length > 0 ? (
        <Portfolio
          domains={domains}
          query={params.q ?? ''}
          within={parseExpiryWindow(params.within)}
        />
      ) : (
        <section
          aria-labelledby="portfolio-heading"
          className="mt-8 rounded-3xl border border-border border-dashed px-6 py-12 text-center sm:py-16"
        >
          <h2 id="portfolio-heading" className="text-lg font-semibold text-foreground">
            No domains yet
          </h2>
          <p className="mx-auto mt-2 max-w-md text-pretty text-sm/6 text-muted-foreground">
            Domains you register or transfer in will appear here, each with its renewal date and
            price.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/search"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              Search for a domain
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link
              href="/transfer"
              className="inline-flex h-11 items-center rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              Transfer one in
            </Link>
          </div>
        </section>
      )}
    </>
  )
}

export default function DomainsPage({ searchParams }: { searchParams: Search }) {
  return (
    <Container className="py-10 sm:py-14">
      <Suspense
        fallback={<div aria-hidden="true" className="h-80 animate-pulse rounded-3xl bg-muted" />}
      >
        <PortfolioPage searchParams={searchParams} />
      </Suspense>
    </Container>
  )
}
