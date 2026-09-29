import type { Metadata } from 'next'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { FeaturedPricing } from '@/features/pricing/components/featured-pricing'
import { PricingTable } from '@/features/pricing/components/pricing-table'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { sortForDisplay, toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { PageJsonLd } from '@/features/seo/components/breadcrumb-json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { env } from '@/lib/env'

export const metadata: Metadata = pageMetadata({
  title: 'Domain pricing',
  description:
    'Every extension we sell, with the first-year price and the renewal price side by side. Naira, VAT and ICANN fees explained in full.',
  path: '/pricing',
})

const PARTS = [
  {
    emoji: '🏛️',
    title: 'The registry fee',
    body: 'What the registry charges to hold the name — Verisign for .com, Public Interest Registry for .org, and so on. It is the bulk of what you pay.',
  },
  {
    emoji: '🤝',
    title: 'Our margin',
    body: 'How we stay in business and keep support answering. The same flat amount on every extension, for each year you register, renew or transfer.',
  },
  {
    emoji: '🌐',
    title: 'The ICANN fee',
    body: 'USD 0.20 per year on generic extensions such as .com and .org, already included in the prices shown. Country extensions such as .co do not carry it.',
  },
  {
    emoji: '🧾',
    title: 'VAT at 7.5%',
    body: 'Added at checkout as its own line, as Nigerian law requires. Prices on this page are shown before VAT.',
  },
] as const

export default async function PricingPage() {
  const priced = await getPricedCatalogue()

  if (!priced) {
    return (
      <>
        <SiteHeader />
        <PageJsonLd trail={[{ name: 'Pricing', path: '/pricing' }]} />
        <main id="main">
          <PageHero eyebrow="Pricing" title="Domain pricing" />
          <Container className="py-16">
            <div className="max-w-2xl">
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
  const featured = priced.featured.slice(0, 4).map(toPublicRow)
  const rows = sortForDisplay(
    priced.tlds.map(toPublicRow),
    priced.featured.map((t) => t.tld),
  )

  return (
    <>
      <SiteHeader />
      <PageJsonLd trail={[{ name: 'Pricing', path: '/pricing' }]} />

      <main id="main">
        <PageHero
          eyebrow="Pricing"
          title="Every price, including the one most registrars hide"
          intro="The renewal price sits next to the first-year price on every row. Where an extension renews higher than it registers, we say so rather than letting you find out in twelve months."
          icons={['🧾', '💵', '🌍']}
        />

        {/* ── Featured ───────────────────────────────────────────────── */}
        <Container className="py-16 sm:py-24">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
              The popular extensions
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              The names most people start with. Each card shows what the second year costs, not just
              the first.
            </p>
          </div>
          <div className="mt-10">
            <FeaturedPricing rows={featured} label="Popular extensions" />
          </div>
        </Container>

        {/* ── What is in the price ───────────────────────────────────── */}
        <Container>
          <div className="rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-7 sm:p-10 lg:p-14">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
                What makes up the price
              </h2>
              <p className="mt-4 text-pretty text-muted-foreground">
                Four things, and nothing else from us — no setup fee, no admin fee. Flutterwave,
                which takes the payment, adds its own processing fee on its payment page.
              </p>
            </div>

            <dl className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
              {PARTS.map((part) => (
                <div key={part.title} className="rounded-3xl bg-background p-6">
                  <span
                    aria-hidden="true"
                    className="grid size-12 place-items-center rounded-2xl bg-brand-subtle text-2xl"
                  >
                    {part.emoji}
                  </span>
                  <dt className="mt-4 font-semibold text-foreground">{part.title}</dt>
                  <dd className="mt-2 text-sm/6 text-muted-foreground">{part.body}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-10 max-w-2xl text-pretty text-sm/6 text-muted-foreground">
              <strong className="font-semibold text-foreground">On the exchange rate.</strong>{' '}
              Registries bill in US dollars and we sell in naira. Every price on this page is
              converted at a fixed rate of{' '}
              <strong className="font-semibold text-foreground">
                ₦{effectiveRate.toLocaleString('en-NG')} to the dollar
              </strong>
              . It does not move with the market during the day, so a price you see in the morning
              is the price you pay in the evening, and a domain in your cart holds its price for{' '}
              {env.PRICE_LOCK_MINUTES} minutes.
            </p>
          </div>
        </Container>

        {/* ── Full catalogue ─────────────────────────────────────────── */}
        <Container className="py-16 sm:py-24">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">All extensions</h2>
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
