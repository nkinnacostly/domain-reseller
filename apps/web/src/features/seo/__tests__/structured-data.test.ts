import { describe, expect, it } from 'vitest'
import {
  aboutPageLd,
  breadcrumbLd,
  extensionServiceLd,
  faqPageLd,
  graph,
  koboToDecimal,
  organizationLd,
  siteUrl,
  websiteLd,
} from '../lib/structured-data'

const SITE = 'https://www.mydomainshub.com'

describe('koboToDecimal (N5)', () => {
  it('writes kobo as naira with two decimals, without floating point', () => {
    expect(koboToDecimal(1_830_000)).toBe('18300.00')
    expect(koboToDecimal(1_830_005)).toBe('18300.05')
    expect(koboToDecimal(0)).toBe('0.00')
  })

  it('refuses anything that is not a whole, non-negative kobo amount', () => {
    expect(() => koboToDecimal(18300.5)).toThrow()
    expect(() => koboToDecimal(-100)).toThrow()
    expect(() => koboToDecimal(Number.NaN)).toThrow()
  })
})

describe('organization and site', () => {
  it('names the operator and the brand, with an absolute logo, and claims nothing unpublished', () => {
    const org = organizationLd(SITE)
    expect(org).toMatchObject({
      '@type': 'OnlineStore',
      '@id': `${SITE}/#organization`,
      name: 'MyDomainsHub',
      legalName: 'CLOOP UNIVERSE TECH',
      url: `${SITE}/`,
      email: 'hello@mydomainshub.com',
      logo: { url: `${SITE}/brand/mydomainshub-mark.png`, width: 512, height: 512 },
    })
    expect(String(org.disambiguatingDescription)).toContain('not itself ICANN-accredited')
    // No figures we have not published: no address, rating, phone or founding date.
    for (const key of ['address', 'aggregateRating', 'review', 'telephone', 'foundingDate']) {
      expect(org).not.toHaveProperty(key)
    }
  })

  it('describes the site and how to search it, published by the organization', () => {
    expect(websiteLd(SITE)).toMatchObject({
      '@type': 'WebSite',
      url: `${SITE}/`,
      publisher: { '@id': `${SITE}/#organization` },
      potentialAction: {
        target: { urlTemplate: `${SITE}/search?q={search_term_string}` },
        'query-input': 'required name=search_term_string',
      },
    })
  })

  it('points an About or Contact page at the organization', () => {
    expect(
      aboutPageLd(SITE, { type: 'ContactPage', path: '/contact', name: 'Contact us' }),
    ).toMatchObject({
      '@type': 'ContactPage',
      url: `${SITE}/contact`,
      isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#website`, url: `${SITE}/` },
      mainEntity: { '@id': `${SITE}/#organization` },
    })
  })
})

describe('breadcrumbs and FAQs', () => {
  it('numbers the trail from 1 with absolute addresses', () => {
    const trail = breadcrumbLd(SITE, [
      { name: 'Home', path: '/' },
      { name: 'Domain extensions', path: '/domains' },
      { name: '.com', path: '/domains/com' },
    ])
    expect(trail.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Domain extensions', item: `${SITE}/domains` },
      { '@type': 'ListItem', position: 3, name: '.com', item: `${SITE}/domains/com` },
    ])
  })

  it('repeats each question and answer, and adds nothing when there are none', () => {
    expect(faqPageLd([{ q: 'Q?', a: 'A.' }])).toEqual({
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } },
      ],
    })
    expect(faqPageLd([])).toBeNull()
  })

  it('leaves missing nodes out of a graph', () => {
    expect(graph({ '@type': 'A' }, null)).toEqual({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'A' }],
    })
  })

  it('builds absolute URLs from paths', () => {
    expect(siteUrl('http://localhost:3100', '/pricing')).toBe('http://localhost:3100/pricing')
  })
})

describe('an extension as a service (N8)', () => {
  const service = extensionServiceLd(SITE, {
    tld: 'com',
    registerKobo: 1_830_000,
    renewKobo: 1_860_000,
    priceText: '₦18,300 for the first year, then ₦18,600 a year to renew, before VAT.',
  })

  it('is a Service in naira — not a Product, which promises a shopping result', () => {
    expect(service).toMatchObject({
      '@type': 'Service',
      name: '.com domain registration',
      url: `${SITE}/domains/com`,
      offers: { '@type': 'Offer', price: '18300.00', priceCurrency: 'NGN' },
    })
    expect(JSON.stringify(service)).not.toContain('"Product"')
  })

  it('carries the renewal price with the first-year price, both per year before VAT', () => {
    const specs = (service.offers as { priceSpecification: Record<string, unknown>[] })
      .priceSpecification
    expect(specs).toEqual([
      expect.objectContaining({
        name: 'First year',
        price: '18300.00',
        valueAddedTaxIncluded: false,
      }),
      expect.objectContaining({
        name: 'Renewal, each year after the first',
        price: '18600.00',
        billingStart: 1,
        valueAddedTaxIncluded: false,
      }),
    ])
    expect(String(service.description)).toContain('then ₦18,600 a year to renew')
  })
})
