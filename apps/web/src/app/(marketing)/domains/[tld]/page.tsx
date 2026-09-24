import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { ExtensionDetails } from '@/features/extensions/components/extension-details'
import { ExtensionFaq } from '@/features/extensions/components/extension-faq'
import { ExtensionPrices } from '@/features/extensions/components/extension-prices'
import {
  describeKind,
  extensionFaqs,
  extensionPrices,
  normaliseExtension,
} from '@/features/extensions/lib/extension'
import { extensionStaticParams, getExtensionPage } from '@/features/extensions/queries/extension'
import { DomainSearch } from '@/features/search/components/domain-search'
import { PageJsonLd } from '@/features/seo/components/breadcrumb-json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { extensionServiceLd, faqPageLd } from '@/features/seo/lib/structured-data'
import { env } from '@/lib/env'

type Params = Promise<{ tld: string }>

/**
 * One landing page per extension we sell (PRD FR-PUB1), public at
 * /domains/{tld} — the panel's own domain pages live under /app.
 *
 * Built from cached reads only (the `pricing` tag, cookie-free clients), so
 * the prerendered extensions are static and every other one is rendered once
 * and kept, like /pricing. An extension we do not sell is a 404: see
 * not-found.tsx beside this file.
 */
export function generateStaticParams() {
  return extensionStaticParams()
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const tld = normaliseExtension((await params).tld)
  const page = tld ? await getExtensionPage(tld) : null
  if (!tld || page?.kind !== 'found') return { title: 'Domain extensions' }

  const prices = extensionPrices(page.pricing, page.facts.isTransferable)
  // N8 — a price in a search snippet still comes with its renewal price.
  const price = prices ? `${prices.register} for the first year, then ${prices.renew} a year. ` : ''
  const description = `Register a .${tld} domain in naira. ${price}${describeKind(tld, page.facts.isCountryCode)}`
  return pageMetadata({
    // The words people search with: the extension, buying it, Nigeria, naira.
    title: `Buy a .${tld} domain in Nigeria — naira prices`,
    description,
    path: `/domains/${tld}`,
  })
}

export default async function ExtensionPage({ params }: { params: Params }) {
  const raw = (await params).tld
  const tld = normaliseExtension(raw)
  // The proxy has already sent /domains/COM to /domains/com; anything still
  // not in canonical form cannot be an extension page.
  if (!tld || tld !== raw) notFound()

  const page = await getExtensionPage(tld)
  if (page.kind === 'missing') notFound()
  // We cannot tell whether we sell it. An error renders error.tsx and, unlike
  // a rendered page, is never kept as this extension's page.
  if (page.kind === 'unavailable') throw new Error('extension page data unavailable')

  const { facts, pricing, vatPct } = page
  const prices = extensionPrices(pricing, facts.isTransferable)
  const faqs = extensionFaqs({ facts, prices, vatPct })

  return (
    <>
      <PageJsonLd
        trail={[
          { name: 'Domain extensions', path: '/domains' },
          { name: `.${tld}`, path: `/domains/${tld}` },
        ]}
        extra={[
          pricing && prices
            ? extensionServiceLd(env.NEXT_PUBLIC_APP_URL, {
                tld,
                registerKobo: pricing.registration.priceKobo,
                renewKobo: pricing.renewal.priceKobo,
                priceText: `${prices.register} for the first year, then ${prices.renew} a year to renew, before VAT.`,
              })
            : null,
          faqPageLd(faqs),
        ]}
      />
      <SiteHeader />

      <main id="main">
        <PageHero
          eyebrow="Domain extensions"
          title={`Register a .${tld} domain`}
          intro={
            prices ? (
              <p>
                {/* N8 — the renewal price travels with the first-year price. */}
                {prices.register} for the first year, then {prices.renew} a year to renew. In naira,
                with VAT added at checkout and Flutterwave’s processing fee on its payment page.
              </p>
            ) : (
              <p>{describeKind(tld, facts.isCountryCode)}</p>
            )
          }
          icons={['🌐', '🔍', '✅']}
        >
          <DomainSearch extension={tld} formLabel={`.${tld} domain search`} />
        </PageHero>

        <ExtensionPrices
          tld={tld}
          prices={prices}
          vatPct={vatPct}
          isCountryCode={facts.isCountryCode}
        />
        <ExtensionDetails facts={facts} prices={prices} />
        <ExtensionFaq tld={tld} faqs={faqs} />
      </main>

      <SiteFooter />
    </>
  )
}
