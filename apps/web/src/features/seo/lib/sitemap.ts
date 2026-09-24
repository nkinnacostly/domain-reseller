import type { MetadataRoute } from 'next'
import { LEGAL_DOCUMENTS } from '@/features/legal/lib/documents'
import { BUSINESS } from '@/lib/business'

/**
 * The public pages we want found, and when each last changed. Google uses
 * `lastmod` only while it keeps proving accurate, so a page gets one only
 * where we know it: legal pages carry their "last updated" date, and pages
 * that show prices change when the prices do (the active exchange rate's
 * start). Everything else goes without rather than claiming "now" on every
 * build. `changefreq` and `priority` are left out: Google ignores both.
 *
 * Not listed: the panel, auth flows, the cart and search results — none is a
 * page anyone should land on from a search (and robots.txt closes lookups).
 */
type Stamp = 'prices' | 'legal' | null

export const PUBLIC_PAGES: readonly { path: string; stamp: Stamp }[] = [
  { path: '/', stamp: 'prices' },
  { path: '/pricing', stamp: 'prices' },
  { path: '/domains', stamp: null },
  { path: '/transfer', stamp: null },
  { path: '/whois', stamp: null },
  { path: '/search/bulk', stamp: null },
  { path: '/help', stamp: null },
  { path: '/about', stamp: null },
  { path: '/contact', stamp: null },
  { path: '/abuse', stamp: null },
  { path: '/status', stamp: null },
  { path: '/legal', stamp: 'legal' },
  ...LEGAL_DOCUMENTS.map((document) => ({ path: document.href, stamp: 'legal' as const })),
]

export function buildSitemap(
  site: string,
  { extensions, pricesFrom }: { extensions: readonly string[]; pricesFrom: Date | null },
): MetadataRoute.Sitemap {
  const legalFrom = new Date(`${BUSINESS.lastUpdatedOn}T00:00:00+01:00`)
  const when = (stamp: Stamp) =>
    stamp === 'legal' ? legalFrom : stamp === 'prices' ? (pricesFrom ?? undefined) : undefined

  const entry = (path: string, stamp: Stamp): MetadataRoute.Sitemap[number] => {
    const lastModified = when(stamp)
    return {
      url: new URL(path, site).toString(),
      ...(lastModified ? { lastModified } : {}),
    }
  }

  return [
    ...PUBLIC_PAGES.map((page) => entry(page.path, page.stamp)),
    ...[...new Set(extensions)].sort().map((tld) => entry(`/domains/${tld}`, 'prices')),
  ]
}
