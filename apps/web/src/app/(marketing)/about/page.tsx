import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { aboutPageLd, organizationLd } from '@/features/seo/lib/structured-data'
import { BUSINESS, SPONSORING_REGISTRAR } from '@/lib/business'
import { env } from '@/lib/env'

export const metadata: Metadata = pageMetadata({
  title: 'About us',
  description: `Who runs ${BUSINESS.brand}, how our prices are made, and what we do and do not do — domain registration for Nigeria, priced in naira.`,
  path: '/about',
})

/**
 * Who we are, for people and for the assistants they ask about us. Every
 * sentence restates a fact another page already makes (N9b): the operator
 * and registrar from the footer and registration agreement, pricing from the
 * pricing page, the transfer promise from the home page's FAQ.
 */
export default function AboutPage() {
  const site = env.NEXT_PUBLIC_APP_URL
  return (
    <LegalPage
      path="/about"
      title={`About ${BUSINESS.brand}`}
      nav="none"
      icons={['🇳🇬', '🌐', '🤝']}
      intro={
        <p>
          {BUSINESS.brand} is where people and businesses in Nigeria buy and look after domain
          names: search, pay in naira, and manage every domain from one account.
        </p>
      }
      structuredData={[
        organizationLd(site),
        aboutPageLd(site, { type: 'AboutPage', path: '/about', name: `About ${BUSINESS.brand}` }),
      ]}
    >
      <LegalSection id="what" title="What we do">
        <p>
          Search for a name and see straight away whether it is free, across hundreds of extensions
          — from .com and .org to .africa and .io. Pay by card or bank transfer through Flutterwave.
          Then point your domain at your host, and manage its nameservers, transfer lock, privacy,
          contacts and renewals yourself. You can also{' '}
          <Link href="/transfer">transfer a domain in</Link> from another registrar.
        </p>
      </LegalSection>

      <LegalSection id="prices" title="Prices you can plan around">
        <p>
          Every price is in naira and shown next to its renewal price, on every screen — some
          extensions renew higher than their first year, and we say so. A price is our supplier’s
          US-dollar price at the day’s exchange rate, plus the ICANN fee on generic extensions and
          the same flat margin on every extension. VAT is added at checkout as its own line. The{' '}
          <Link href="/pricing">pricing page</Link> lists them all.
        </p>
      </LegalSection>

      <LegalSection id="who" title="Who we are">
        <p>
          {BUSINESS.brand} is operated by {BUSINESS.operator}. We are an authorised reseller, not an
          ICANN-accredited registrar: your domain is registered through our supplier’s accredited
          registrar, which the domain’s public record names. For .com that is{' '}
          {SPONSORING_REGISTRAR.name} (IANA ID {SPONSORING_REGISTRAR.ianaId}). The{' '}
          <Link href="/legal/registration-agreement">registration agreement</Link> sets out the
          terms.
        </p>
      </LegalSection>

      <LegalSection id="yours" title="Your domain stays yours">
        <p>
          You can move a domain away whenever you like. We release its authorisation code within
          five days of you asking, and never withhold it over an unpaid invoice.
        </p>
      </LegalSection>

      <LegalSection id="not" title="What we do not do">
        <p>
          We register and manage domains; we do not host websites or email. Point your domain at the
          company that hosts them, or at a DNS service such as Cloudflare.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Talk to us">
        <p>
          Email <EmailLink />, or start with the <Link href="/help">help centre</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
