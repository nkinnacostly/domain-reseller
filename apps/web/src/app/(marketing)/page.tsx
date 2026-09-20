import type { Metadata } from 'next'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { Faq } from '@/features/marketing/components/faq'
import { FinalCta } from '@/features/marketing/components/final-cta'
import { HowItWorks } from '@/features/marketing/components/how-it-works'
import { PricingPromise } from '@/features/marketing/components/pricing-promise'
import { StatsStrip } from '@/features/marketing/components/stats-strip'
import { WhyUs } from '@/features/marketing/components/why-us'
import { DomainSearch } from '@/features/search/components/domain-search'
import { HeroVisual } from '@/features/search/components/hero-visual'
import { PopularExtensions } from '@/features/search/components/popular-extensions'
import { TrendingDomains } from '@/features/search/components/trending-domains'

export const metadata: Metadata = {
  title: 'Domain names, priced in naira',
  description:
    'Search 700+ domain extensions including .ng and .com.ng. Renewal price shown upfront, pay with your Nigerian card, point it at your host in seconds.',
}

export default function HomePage() {
  return (
    <>
      {/* Floated so <header> stays a banner landmark outside <main>, while the
          hero's h1 and search sit inside main where they belong. */}
      <SiteHeader className="absolute inset-x-0 top-0" />

      <main id="main">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <div className="relative bg-gradient-to-br from-hero-from to-hero-to">
          <Container className="grid items-center gap-8 pt-28 pb-16 sm:pt-32 sm:pb-20 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-28">
            <div className="max-w-xl">
              <h1 className="text-[2.5rem] leading-[1.06] font-bold tracking-[-0.02em] text-balance text-foreground sm:text-5xl lg:text-[3.5rem]">
                The domain you want, priced in naira
              </h1>

              <p className="mt-5 max-w-md text-pretty text-muted-foreground">
                Search 700+ extensions including .ng and .com.ng. We show the renewal price next to
                the first-year price — every time, on every screen.
              </p>

              <div className="relative mt-9">
                {/* Dotted grid, lifted from the reference's corner detail. */}
                <div
                  aria-hidden="true"
                  className="absolute -bottom-9 -left-2 hidden size-24 opacity-40 sm:block"
                  style={{
                    backgroundImage: 'radial-gradient(currentColor 1.5px, transparent 1.5px)',
                    backgroundSize: '11px 11px',
                    color: 'var(--muted-foreground)',
                  }}
                />
                <div className="relative">
                  <DomainSearch />
                </div>
              </div>
            </div>

            <HeroVisual className="mx-auto max-w-md lg:max-w-none" />
          </Container>
        </div>

        <StatsStrip />

        {/* ── Extensions and trending ────────────────────────────────── */}
        <Container className="grid gap-12 py-14 sm:py-20 lg:grid-cols-[1.9fr_1fr] lg:gap-16">
          <PopularExtensions />
          <TrendingDomains />
        </Container>

        <HowItWorks />
        <WhyUs />
        <PricingPromise />
        <Faq />
        <FinalCta />
      </main>

      <SiteFooter />
    </>
  )
}
