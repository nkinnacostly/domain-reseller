import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DOCS_PAGES } from '@/features/api/docs/pages'
import { ROWS } from '@/features/pricing/__tests__/fixtures'
import { toCatalogue } from '@/features/pricing/lib/plans'
import { JsonLd, PageJsonLd } from '../components/json-ld'
import {
  INDEXABLE,
  NOT_YET_INDEXED,
  pageMetadata,
  publicRobots,
  SHARE_IMAGE,
} from '../lib/metadata'
import { PRIVATE_PATHS, robotsRules } from '../lib/robots'
import { buildSitemap, PUBLIC_PAGES } from '../lib/sitemap'
import {
  breadcrumbLd,
  faqPageLd,
  graph,
  koboToDecimal,
  organizationLd,
  plansServiceLd,
  siteUrl,
  websiteLd,
} from '../lib/structured-data'

const SITE = 'https://emails.mydomainshub.com'

describe('pageMetadata', () => {
  it('gives a canonical address, a complete share card, and opens pages to search now Mail is open', () => {
    const meta = pageMetadata({ title: 'Pricing', description: 'Plans.', path: '/pricing' })
    expect(meta.title).toBe('Pricing')
    expect(meta.alternates).toEqual({ canonical: '/pricing' })
    expect(meta.openGraph).toMatchObject({
      siteName: 'MyDomainsHub Mail',
      locale: 'en_NG',
      url: '/pricing',
      title: 'Pricing · MyDomainsHub Mail',
      images: [SHARE_IMAGE],
    })
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image' })
    expect(meta.robots).toEqual(INDEXABLE)
  })

  it('takes an absolute title for the home page', () => {
    const meta = pageMetadata({ title: 'Home', description: 'x', path: '/', absolute: true })
    expect(meta.title).toEqual({ absolute: 'Home' })
    expect(meta.openGraph).toMatchObject({ title: 'Home' })
  })

  it('opens pages to search with one switch', () => {
    expect(publicRobots(true)).toEqual(INDEXABLE)
    expect(publicRobots(false)).toEqual(NOT_YET_INDEXED)
  })
})

describe('robots.txt', () => {
  it('closes the dashboard, the API and auth callbacks, and names the sitemap', () => {
    const rules = robotsRules(SITE)
    expect(PRIVATE_PATHS).toEqual(['/dashboard', '/api/', '/auth/'])
    expect(rules.rules).toEqual([
      { userAgent: '*', allow: '/', disallow: ['/dashboard', '/api/', '/auth/'] },
    ])
    expect(rules.sitemap).toBe(`${SITE}/sitemap.xml`)
  })
})

describe('sitemap.xml (dates only where true)', () => {
  it('lists every public page and none of the private ones', () => {
    const urls = buildSitemap(SITE, { plansUpdatedAt: null }).map((entry) => entry.url)
    expect(urls).toEqual(
      PUBLIC_PAGES.map((page) => `${SITE}${page.path === '/' ? '/' : page.path}`),
    )
    expect(urls).toContain(`${SITE}/legal/sub-processors`)
    expect(urls.some((url) => /dashboard|sign-in|sign-up|\/api\//.test(url))).toBe(false)
  })

  it('lists every docs page once, undated: nothing records when a guide changed', () => {
    const entries = buildSitemap(SITE, { plansUpdatedAt: '2026-10-06T11:00:00.000Z' })
    for (const page of DOCS_PAGES) {
      const found = entries.filter((entry) => entry.url === `${SITE}${page.href}`)
      expect(found, page.href).toHaveLength(1)
      expect(found[0], page.href).not.toHaveProperty('lastModified')
    }
    expect(entries.map((entry) => entry.url)).toEqual(
      expect.arrayContaining([`${SITE}/docs/webhooks`, `${SITE}/docs/quickstart`]),
    )
  })

  it('dates legal pages by the drafts, plan pages by the plan rows, the rest not at all', () => {
    const entries = buildSitemap(SITE, { plansUpdatedAt: '2026-10-06T11:00:00.000Z' })
    const at = (path: string) => entries.find((entry) => entry.url === `${SITE}${path}`)
    expect(at('/legal/terms')?.lastModified).toEqual(new Date('2026-10-06T00:00:00+01:00'))
    expect(at('/pricing')?.lastModified).toEqual(new Date('2026-10-06T11:00:00.000Z'))
    expect(at('/')?.lastModified).toEqual(new Date('2026-10-06T11:00:00.000Z'))
    expect(at('/docs')).not.toHaveProperty('lastModified')
    expect(at('/contact')).not.toHaveProperty('lastModified')
  })

  it('leaves plan pages undated when the plans could not be read', () => {
    const entries = buildSitemap(SITE, { plansUpdatedAt: null })
    expect(entries.find((entry) => entry.url === `${SITE}/pricing`)).not.toHaveProperty(
      'lastModified',
    )
  })
})

describe('structured data repeats the page, never adds to it', () => {
  it('prices in kobo become schema.org decimals without floating point (N5)', () => {
    expect(koboToDecimal(2_000_000)).toBe('20000.00')
    expect(koboToDecimal(0)).toBe('0.00')
    expect(koboToDecimal(5)).toBe('0.05')
    expect(() => koboToDecimal(1.5)).toThrow()
    expect(() => koboToDecimal(-1)).toThrow()
  })

  it('each offered plan is an offer at its monthly price before VAT, with no availability claim', () => {
    const { plans } = toCatalogue(ROWS)
    const node = plansServiceLd(SITE, { plans, description: 'Intro.' })
    expect(node).toMatchObject({
      '@type': 'Service',
      description: 'Intro.',
      url: `${SITE}/pricing`,
    })
    const offers = (node?.offers ?? []) as Record<string, unknown>[]
    expect(offers.map((offer) => offer.name)).toEqual(['Free plan', 'Starter plan', 'Pro plan'])
    expect(offers.map((offer) => offer.price)).toEqual(['0.00', '20000.00', '55000.00'])
    for (const offer of offers) {
      expect(offer).not.toHaveProperty('availability')
      expect(offer.priceCurrency).toBe('NGN')
      expect(offer.priceSpecification).toMatchObject({
        unitCode: 'MON',
        billingDuration: 1,
        valueAddedTaxIncluded: false,
      })
    }
    expect(JSON.stringify(node)).not.toContain('Scale')
    expect(plansServiceLd(SITE, { plans: [], description: 'x' })).toBeNull()
  })

  it('the organization and the site carry only what the footer states', () => {
    expect(organizationLd(SITE)).toMatchObject({
      name: 'MyDomainsHub',
      legalName: 'CLOOP UNIVERSE TECH LTD',
      email: 'hello@mydomainshub.com',
      url: 'https://www.mydomainshub.com',
    })
    expect(organizationLd(SITE)).not.toHaveProperty('address')
    expect(websiteLd(SITE)).toMatchObject({ name: 'MyDomainsHub Mail', url: `${SITE}/` })
  })

  it('breadcrumbs, FAQs and graphs', () => {
    expect(breadcrumbLd(SITE, [{ name: 'Home', path: '/' }])).toMatchObject({
      itemListElement: [{ position: 1, name: 'Home', item: `${SITE}/` }],
    })
    expect(faqPageLd([])).toBeNull()
    expect(faqPageLd([{ q: 'Q?', a: 'A.' }])).toMatchObject({
      mainEntity: [{ name: 'Q?', acceptedAnswer: { text: 'A.' } }],
    })
    expect(graph({ a: 1 }, null)).toEqual({
      '@context': 'https://schema.org',
      '@graph': [{ a: 1 }],
    })
    expect(siteUrl(SITE, '/x')).toBe(`${SITE}/x`)
  })

  it('JSON-LD is escaped so a value can never close its script tag', () => {
    const { container } = render(<JsonLd data={{ name: '</script><b>' }} />)
    const script = container.querySelector('script[type="application/ld+json"]')
    expect(script?.innerHTML).not.toContain('</script>')
    expect(JSON.parse(script?.innerHTML ?? '{}')).toEqual({ name: '</script><b>' })
  })

  it('a page’s trail starts at Home; no trail, no breadcrumb', () => {
    const { container, unmount } = render(<PageJsonLd trail={[{ name: 'Docs', path: '/docs' }]} />)
    const data = JSON.parse(container.querySelector('script')?.innerHTML ?? '{}')
    expect(data['@graph'][0].itemListElement.map((item: { name: string }) => item.name)).toEqual([
      'Home',
      'Docs',
    ])
    unmount()
    const empty = render(<PageJsonLd trail={[]} />)
    expect(
      JSON.parse(empty.container.querySelector('script')?.innerHTML ?? '{}')['@graph'],
    ).toEqual([])
  })
})
