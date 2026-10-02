import { Certificate, EnvelopeSimple, LockKey } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { PageJsonLd } from '@/features/seo/components/breadcrumb-json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { certificateServiceLd, faqPageLd } from '@/features/seo/lib/structured-data'
import { SSL_FAQS, SslGuide } from '@/features/ssl/components/ssl-guide'
import { SslOffers } from '@/features/ssl/components/ssl-offers'
import { toSslOffers } from '@/features/ssl/lib/offers'
import { getSslCatalogue } from '@/features/ssl/queries/catalogue'
import { env } from '@/lib/env'

export const metadata: Metadata = pageMetadata({
  title: 'SSL certificates',
  description:
    'Sectigo PositiveSSL certificates — one name, several names, or a wildcard — priced in naira. A one-year subscription; you install the certificate on your own server or hosting.',
  path: '/ssl',
})

/**
 * FR-SSL-1: the SSL storefront. Public and cached with the prices (the
 * `pricing` tag); the add-to-cart boxes are the only interactive part.
 */
export default async function SslPage() {
  const catalogue = await getSslCatalogue()
  const offers = catalogue ? toSslOffers(catalogue.products) : null

  return (
    <>
      <SiteHeader />
      <PageJsonLd
        trail={[{ name: 'SSL certificates', path: '/ssl' }]}
        extra={[
          ...(offers ?? []).map((offer) =>
            certificateServiceLd(env.NEXT_PUBLIC_APP_URL, {
              productCode: offer.productCode,
              name: offer.name,
              priceKobo: offer.priceKobo,
              description: `${offer.covers} ${offer.term}. ${offer.renewal}`,
            }),
          ),
          faqPageLd(SSL_FAQS),
        ]}
      />

      <main id="main">
        <PageHero
          eyebrow="SSL certificates"
          title="The padlock, for a site you host yourself"
          intro={
            <p>
              Sectigo PositiveSSL certificates, priced in naira. You set one up here, approve it by
              email, then install it on your own server or hosting. Many hosts already give you one
              free — <Link href="#ssl-faq-heading">check first</Link>.
            </p>
          }
          icons={[LockKey, Certificate, EnvelopeSimple]}
        />
        <SslOffers offers={offers} vatPct={catalogue?.vatPct ?? null} />
        <SslGuide />
      </main>

      <SiteFooter />
    </>
  )
}
