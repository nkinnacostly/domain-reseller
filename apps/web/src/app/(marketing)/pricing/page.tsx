import type { Metadata } from 'next'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { FeaturedPricing } from '@/features/pricing/components/featured-pricing'
import { PricingTable } from '@/features/pricing/components/pricing-table'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { NIGERIAN_TLDS, sortForDisplay, toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'

export const metadata: Metadata = {
  title: 'Domain pricing',
  description:
    'Every extension we sell, with the first-year price and the renewal price side by side. Naira, VAT and ICANN fees explained in full.',
}

export default async function PricingPage() {
  const priced = await getPricedCatalogue()

  if (!priced) {
    return (
      <>
        <SiteHeader className="border-border/60 border-b" />
        <main id="main">
          <Container className="py-20">
            <h1 className="text-3xl font-bold tracking-tight">Domain pricing</h1>
            <div className="mt-8 max-w-2xl">
              <PricingUnavailable />
            </div>
          </Container>
        </main>
        <SiteFooter />
      </>
    )
  }

  const effectiveRate = priced.effectiveRate

  // Cost and margin never leave the server — see toPublicRow.
  const rows = sortForDisplay(priced.tlds.map(toPublicRow))
  const featured = (NIGERIAN_TLDS as readonly string[])
    .map((tld) => rows.find((row) => row.tld === tld))
    .filter((row): row is (typeof rows)[number] => Boolean(row))

  return (
    <>
      <SiteHeader className="border-border/60 border-b" />

      <main id="main">
        {/* ── Intro ──────────────────────────────────────────────────── */}
        <div className="bg-gradient-to-br from-hero-from to-hero-to">
          <Container className="py-14 sm:py-20">
            <div className="max-w-2xl">
              <h1 className="text-[2.25rem] leading-[1.08] font-bold tracking-[-0.02em] text-balance sm:text-5xl">
                Every price, including the one most registrars hide
              </h1>
              <p className="mt-5 text-pretty text-muted-foreground">
                The renewal price sits next to the first-year price on every row. Where an extension
                renews higher than it registers, we say so rather than letting you find out in
                twelve months.
              </p>
            </div>
          </Container>
        </div>

        {/* ── Nigerian range ─────────────────────────────────────────── */}
        <Container className="py-14 sm:py-20">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              The Nigerian extensions
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              One price every year. These cost the same to register and to renew, and we price them
              the same way — no first-year discount that turns into a bill later.
            </p>
          </div>
          <div className="mt-8">
            <FeaturedPricing rows={featured} />
          </div>
        </Container>

        {/* ── What is in the price ───────────────────────────────────── */}
        <div className="bg-muted/40">
          <Container className="py-14 sm:py-20">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                What makes up the price
              </h2>
              <p className="mt-4 text-pretty text-muted-foreground">
                Four things, and nothing else. No setup fee, no admin fee, nothing added at the last
                step.
              </p>
            </div>

            <dl className="mt-10 grid gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="font-semibold text-foreground">The registry fee</dt>
                <dd className="mt-2 text-sm/6 text-muted-foreground">
                  What the registry charges to hold the name — NiRA for .ng, Verisign for .com, and
                  so on. It is the bulk of what you pay.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">Our margin</dt>
                <dd className="mt-2 text-sm/6 text-muted-foreground">
                  How we stay in business and keep support answering. Thinner on registration than
                  on renewal, and thinnest of all on transfers.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">The ICANN fee</dt>
                <dd className="mt-2 text-sm/6 text-muted-foreground">
                  USD 0.20 per year on generic extensions such as .com and .org. Country extensions
                  including .ng and .com.ng do not carry it. Rows above show which.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">VAT at 7.5%</dt>
                <dd className="mt-2 text-sm/6 text-muted-foreground">
                  Added at checkout as its own line, as Nigerian law requires. Prices on this page
                  are shown before VAT.
                </dd>
              </div>
            </dl>

            <p className="mt-10 max-w-2xl text-pretty text-sm/6 text-muted-foreground">
              <strong className="font-semibold text-foreground">On the exchange rate.</strong>{' '}
              Registries bill in US dollars and we sell in naira. Every price on this page is
              converted at a fixed rate of{' '}
              <strong className="font-semibold text-foreground">
                ₦{effectiveRate.toLocaleString('en-NG')} to the dollar
              </strong>
              . It does not move with the market during the day, so a price you see in the morning
              is the price you pay in the evening, and a domain in your cart holds its price for 30
              minutes.
            </p>
          </Container>
        </div>

        {/* ── Full catalogue ─────────────────────────────────────────── */}
        <Container className="py-14 sm:py-20">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">All extensions</h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              Prices in naira, excluding VAT. Transfers include an extra year where the registry
              allows it; a dash means we cannot currently transfer that extension in.
            </p>
          </div>

          <div className="mt-8">
            <PricingTable rows={rows} />
          </div>

          <p className="mt-10 max-w-2xl text-pretty text-sm/6 text-muted-foreground">
            Recovering an expired domain after the grace period costs considerably more than a
            renewal — registries set that fee themselves and it varies by extension, so we quote it
            at the time. Renewing on time always costs less.
          </p>
        </Container>
      </main>

      <SiteFooter />
    </>
  )
}
