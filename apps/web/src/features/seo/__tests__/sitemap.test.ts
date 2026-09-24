import { describe, expect, it } from 'vitest'
import { LEGAL_DOCUMENTS } from '@/features/legal/lib/documents'
import { buildSitemap } from '../lib/sitemap'

const SITE = 'https://www.mydomainshub.com'
const PRICES_FROM = new Date('2026-09-24T12:23:07Z')

describe('sitemap', () => {
  const entries = buildSitemap(SITE, { extensions: ['net', 'com', 'com'], pricesFrom: PRICES_FROM })
  const byPath = new Map(entries.map((entry) => [new URL(entry.url).pathname, entry]))

  it('lists the public pages and every extension page once, with absolute addresses', () => {
    for (const path of [
      '/',
      '/pricing',
      '/domains',
      '/transfer',
      '/help',
      '/about',
      '/contact',
      '/legal',
    ]) {
      expect(byPath.has(path), path).toBe(true)
    }
    for (const document of LEGAL_DOCUMENTS) expect(byPath.has(document.href)).toBe(true)
    expect(entries.filter((entry) => entry.url.includes('/domains/com'))).toHaveLength(1)
    expect(entries.every((entry) => entry.url.startsWith(`${SITE}/`))).toBe(true)
  })

  it('leaves out the panel, auth flows, the cart and search results', () => {
    for (const entry of entries) {
      expect(entry.url).not.toMatch(/\/(app|api|auth|cart|sign-in|sign-up|verify)(\/|$)/)
      expect(new URL(entry.url).pathname).not.toBe('/search')
    }
  })

  it('dates price pages by the prices and legal pages by their last update — nothing else', () => {
    expect(byPath.get('/domains/com')?.lastModified).toEqual(PRICES_FROM)
    expect(byPath.get('/pricing')?.lastModified).toEqual(PRICES_FROM)
    expect(byPath.get('/legal/privacy')?.lastModified).toEqual(
      new Date('2026-09-24T00:00:00+01:00'),
    )
    expect(byPath.get('/help')).not.toHaveProperty('lastModified')
  })

  it('claims no date for price pages when prices are withheld', () => {
    const withheld = buildSitemap(SITE, { extensions: ['com'], pricesFrom: null })
    expect(withheld.find((entry) => entry.url.endsWith('/domains/com'))).not.toHaveProperty(
      'lastModified',
    )
  })
})
