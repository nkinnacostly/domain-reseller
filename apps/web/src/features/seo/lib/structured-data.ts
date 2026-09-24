import { BRAND_NAME } from '@/components/layout/brand'
import { BUSINESS, SPONSORING_REGISTRAR } from '@/lib/business'

/**
 * Structured data (schema.org JSON-LD) for search engines and AI assistants.
 * Every value here must also be on the page a person sees — Google's rule,
 * and ours (N9b): markup describes the page, it never adds claims to it. So
 * no ratings, no address, no founding date: we have published none.
 *
 * Pure: the site URL comes in, so tests need no environment.
 */

export type JsonLdNode = Record<string, unknown>

/** An absolute URL on the site. */
export function siteUrl(site: string, path = '/'): string {
  return new URL(path, site).toString()
}

const organizationId = (site: string) => `${siteUrl(site)}#organization`
const websiteId = (site: string) => `${siteUrl(site)}#website`

/**
 * Integer kobo to a schema.org price ("18300.00"), without floating point
 * (N5): structured data is a display edge like formatNaira.
 */
export function koboToDecimal(kobo: number): string {
  if (!Number.isSafeInteger(kobo) || kobo < 0) throw new Error(`not a kobo amount: ${kobo}`)
  return `${Math.trunc(kobo / 100)}.${String(kobo % 100).padStart(2, '0')}`
}

/** A graph: several nodes in one script tag, linked by `@id`. */
export function graph(...nodes: (JsonLdNode | null)[]): JsonLdNode {
  return { '@context': 'https://schema.org', '@graph': nodes.filter((node) => node !== null) }
}

/**
 * Who we are. OnlineStore is Google's recommended Organization subtype for a
 * business that sells online. The legal name, the contact address and the
 * reseller relationship are the facts the footer and legal pages state.
 */
export function organizationLd(site: string): JsonLdNode {
  return {
    '@type': 'OnlineStore',
    '@id': organizationId(site),
    name: BRAND_NAME,
    alternateName: ['My Domains Hub', BUSINESS.site],
    legalName: BUSINESS.operator,
    url: siteUrl(site),
    logo: {
      '@type': 'ImageObject',
      url: siteUrl(site, '/brand/mydomainshub-mark.png'),
      width: 512,
      height: 512,
    },
    image: siteUrl(site, '/opengraph-image.png'),
    description:
      'Domain name registration for Nigeria: search, pay in naira and manage your domains, with the renewal price shown next to the first-year price.',
    email: BUSINESS.email,
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'customer support',
        email: BUSINESS.email,
        areaServed: 'NG',
        availableLanguage: ['English'],
      },
    ],
    areaServed: { '@type': 'Country', name: 'Nigeria' },
    knowsAbout: ['Domain names', 'Domain registration', 'Domain transfers', 'DNS nameservers'],
    // CMP-1: we resell; the accredited registrar is our supplier's, as the footer says.
    disambiguatingDescription: `${BRAND_NAME} is operated by ${BUSINESS.operator}, an authorised reseller — not itself ICANN-accredited. .com registrations are sponsored by ${SPONSORING_REGISTRAR.name} (IANA ID ${SPONSORING_REGISTRAR.ianaId}).`,
  }
}

/** The site itself, and how to search it (read by engines that still use SearchAction). */
export function websiteLd(site: string): JsonLdNode {
  return {
    '@type': 'WebSite',
    '@id': websiteId(site),
    name: BRAND_NAME,
    alternateName: ['My Domains Hub', BUSINESS.site],
    url: siteUrl(site),
    inLanguage: 'en-NG',
    publisher: { '@id': organizationId(site) },
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${siteUrl(site, '/search')}?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  }
}

export type Crumb = { name: string; path: string }

/** The trail from the home page to this one; the last crumb is the page itself. */
export function breadcrumbLd(site: string, crumbs: Crumb[]): JsonLdNode {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: siteUrl(site, crumb.path),
    })),
  }
}

export type QA = { q: string; a: string }

/** Questions answered on the page, word for word. */
export function faqPageLd(faqs: QA[]): JsonLdNode | null {
  if (faqs.length === 0) return null
  return {
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: faq.a },
    })),
  }
}

/** An About or Contact page, about the organization. */
export function aboutPageLd(
  site: string,
  { type, path, name }: { type: 'AboutPage' | 'ContactPage'; path: string; name: string },
): JsonLdNode {
  return {
    '@type': type,
    '@id': `${siteUrl(site, path)}#webpage`,
    url: siteUrl(site, path),
    name,
    inLanguage: 'en-NG',
    isPartOf: { '@id': websiteId(site) },
    about: { '@id': organizationId(site) },
    mainEntity: { '@id': organizationId(site) },
  }
}

export type ExtensionOffer = {
  tld: string
  registerKobo: number
  renewKobo: number
  /** Human wording of both prices, as the page shows them (N8). */
  priceText: string
}

/**
 * One extension as a service we sell: a year's registration, priced in naira.
 * A Service, not a Product: nothing tangible changes hands, which is how
 * Google's shopping policies class it, so Product markup would promise a
 * shopping result it could never get. The first-year and renewal prices both
 * go in (N8), each per year and before VAT — as the page shows them.
 */
export function extensionServiceLd(site: string, offer: ExtensionOffer): JsonLdNode {
  const url = siteUrl(site, `/domains/${offer.tld}`)
  const year = { '@type': 'QuantitativeValue', value: 1, unitCode: 'ANN' }
  return {
    '@type': 'Service',
    '@id': `${url}#service`,
    name: `.${offer.tld} domain registration`,
    serviceType: 'Domain name registration',
    description: `Register a .${offer.tld} domain name with ${BRAND_NAME}. ${offer.priceText}`,
    url,
    brand: { '@type': 'Brand', name: BRAND_NAME },
    provider: { '@type': 'Organization', name: BRAND_NAME, url: siteUrl(site) },
    areaServed: { '@type': 'Country', name: 'Nigeria' },
    offers: {
      '@type': 'Offer',
      url,
      price: koboToDecimal(offer.registerKobo),
      priceCurrency: 'NGN',
      availability: 'https://schema.org/InStock',
      description: offer.priceText,
      priceSpecification: [
        {
          '@type': 'UnitPriceSpecification',
          name: 'First year',
          price: koboToDecimal(offer.registerKobo),
          priceCurrency: 'NGN',
          referenceQuantity: year,
          valueAddedTaxIncluded: false,
        },
        {
          '@type': 'UnitPriceSpecification',
          name: 'Renewal, each year after the first',
          price: koboToDecimal(offer.renewKobo),
          priceCurrency: 'NGN',
          referenceQuantity: year,
          billingStart: 1,
          valueAddedTaxIncluded: false,
        },
      ],
    },
  }
}
