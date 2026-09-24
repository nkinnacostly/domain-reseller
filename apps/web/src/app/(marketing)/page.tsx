import { formatNaira, vatKobo } from '@dr/shared'
import type { Metadata } from 'next'
import { JsonLd } from '@/components/common/json-ld'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { getNameserverPresets } from '@/features/domains/queries/domains'
import { Faq, HOME_FAQS } from '@/features/marketing/components/faq'
import { FinalCta } from '@/features/marketing/components/final-cta'
import { Hero } from '@/features/marketing/components/hero'
import { HowItWorks } from '@/features/marketing/components/how-it-works'
import type { Quote } from '@/features/marketing/components/phone-screens'
import { StatsStrip } from '@/features/marketing/components/stats-strip'
import { WhyUs } from '@/features/marketing/components/why-us'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { PopularExtensions } from '@/features/search/components/popular-extensions'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { faqPageLd, graph, organizationLd, websiteLd } from '@/features/seo/lib/structured-data'
import { env } from '@/lib/env'

export async function generateMetadata(): Promise<Metadata> {
  const priced = await getPricedCatalogue()
  const count = priced ? `${priced.tlds.length.toLocaleString('en-NG')} ` : ''
  return pageMetadata({
    // What people type: buying a domain, in Nigeria, in naira.
    title: 'Buy domain names in Nigeria, priced in naira',
    description: `Search ${count}domain extensions. Renewal price shown upfront, pay with your Nigerian card, point it at your host in seconds.`,
    path: '/',
  })
}

export default async function HomePage() {
  // The phone mockups quote real prices, so they read the live catalogue like
  // every other price on the site (N5b). Whatever the database ranks first leads.
  const [priced, presets] = await Promise.all([getPricedCatalogue(), getNameserverPresets()])

  const quotes: Quote[] = (priced?.featured ?? []).map((t) => ({
    tld: t.tld,
    firstYear: formatNaira(t.registration.priceKobo),
    renewal: formatNaira(t.renewal.priceKobo),
  }))
  const lead = quotes[0] ?? null
  const leadPricing = priced?.featured[0]
  const vat =
    priced && leadPricing
      ? (() => {
          const amount = vatKobo(leadPricing.registration.priceKobo, priced.vatPct)
          return {
            pct: priced.vatPct,
            amount: formatNaira(amount),
            total: formatNaira(leadPricing.registration.priceKobo + amount),
          }
        })()
      : null
  const hosts = presets.map((preset) => preset.provider)
  const extensionCount = priced?.tlds.length ?? null

  const site = env.NEXT_PUBLIC_APP_URL

  return (
    <>
      <JsonLd
        data={graph(
          organizationLd(site),
          websiteLd(site),
          faqPageLd(HOME_FAQS.map((faq) => ({ q: faq.q, a: faq.a }))),
        )}
      />
      <SiteHeader />

      <main id="main">
        <Hero extensionCount={extensionCount} lead={lead} host={hosts[0] ?? null} />
        <StatsStrip />
        <HowItWorks
          lead={lead}
          more={quotes.slice(1, 4)}
          vat={vat}
          hosts={hosts}
          extensionCount={extensionCount}
          holdMinutes={env.PRICE_LOCK_MINUTES}
        />
        <WhyUs rate={priced?.effectiveRate ?? null} />
        <PopularExtensions />
        <Faq />
        <FinalCta tlds={quotes.slice(1, 5).map((quote) => quote.tld)} />
      </main>

      <SiteFooter />
    </>
  )
}
