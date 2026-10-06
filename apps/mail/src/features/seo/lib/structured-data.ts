import { BRAND_NAME, PRODUCT_NAME } from '@/components/layout/brand'
import { type Plan, planSummary } from '@/features/pricing/lib/plans'
import { BUSINESS } from '@/lib/business'

/**
 * Structured data (schema.org JSON-LD) for search engines and AI assistants.
 * Every value here is also on the page a person sees — Google's rule, and
 * ours (N9b): markup describes the page, it never adds to it. So no ratings,
 * no address, no availability claim for plans that are not on sale.
 *
 * Pure: the site URL comes in, so tests need no environment.
 */

export type JsonLdNode = Record<string, unknown>

/** An absolute URL on the site. */
export const siteUrl = (site: string, path = '/'): string => new URL(path, site).toString()

const organizationId = (site: string) => `${siteUrl(site)}#organization`
const websiteId = (site: string) => `${siteUrl(site)}#website`

/** Integer kobo to a schema.org price ("20000.00"), without floating point (N5). */
export function koboToDecimal(kobo: number): string {
  if (!Number.isSafeInteger(kobo) || kobo < 0) throw new Error(`not a kobo amount: ${kobo}`)
  return `${Math.trunc(kobo / 100)}.${String(kobo % 100).padStart(2, '0')}`
}

/** A graph: several nodes in one script tag, linked by `@id`. */
export function graph(...nodes: (JsonLdNode | null)[]): JsonLdNode {
  return { '@context': 'https://schema.org', '@graph': nodes.filter((node) => node !== null) }
}

/** Who runs Mail: the facts the footer and the contact page state. */
export function organizationLd(site: string): JsonLdNode {
  return {
    '@type': 'Organization',
    '@id': organizationId(site),
    name: BRAND_NAME,
    legalName: BUSINESS.operator,
    url: BUSINESS.shopUrl,
    logo: siteUrl(site, '/icon.svg'),
    email: BUSINESS.email,
    contactPoint: [
      { '@type': 'ContactPoint', contactType: 'customer support', email: BUSINESS.email },
    ],
  }
}

/** The site itself (home page only). */
export function websiteLd(site: string): JsonLdNode {
  return {
    '@type': 'WebSite',
    '@id': websiteId(site),
    name: PRODUCT_NAME,
    url: siteUrl(site),
    inLanguage: 'en-NG',
    publisher: { '@id': organizationId(site) },
  }
}

export type Crumb = { name: string; path: string }

/** The trail from the home page to this one; the last crumb is the page itself. */
export function breadcrumbLd(site: string, crumbs: readonly Crumb[]): JsonLdNode {
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
export function faqPageLd(faqs: readonly QA[]): JsonLdNode | null {
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

/**
 * Mail as a service with its plans (the pricing page). Each offer is a plan
 * the page lists: its monthly price before VAT, and the page's own words for
 * what it includes. No availability: the page says paid plans are not on
 * sale yet, and markup must not say otherwise.
 */
export function plansServiceLd(
  site: string,
  { plans, description }: { plans: readonly Plan[]; description: string },
): JsonLdNode | null {
  if (plans.length === 0) return null
  const url = siteUrl(site, '/pricing')
  return {
    '@type': 'Service',
    '@id': `${url}#service`,
    name: PRODUCT_NAME,
    serviceType: 'Transactional email API',
    description,
    url,
    provider: { '@id': organizationId(site) },
    areaServed: { '@type': 'Country', name: 'Nigeria' },
    offers: plans.map((plan) => ({
      '@type': 'Offer',
      name: `${plan.name} plan`,
      url,
      price: koboToDecimal(plan.priceKobo),
      priceCurrency: 'NGN',
      description: planSummary(plan),
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: koboToDecimal(plan.priceKobo),
        priceCurrency: 'NGN',
        billingDuration: 1,
        unitCode: 'MON',
        valueAddedTaxIncluded: false,
      },
    })),
  }
}
