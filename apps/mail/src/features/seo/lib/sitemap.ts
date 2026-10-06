import type { MetadataRoute } from 'next'
import { LEGAL_DOCUMENTS } from '@/features/legal/lib/documents'
import { BUSINESS } from '@/lib/business'

/**
 * The public pages, and when each last changed. Google uses `lastmod` only
 * while it keeps proving accurate, so a page gets one only where we know it
 * (CLAUDE.md §15): the legal pages carry their date, and pages that show
 * plan figures change when a plan row does. Everything else goes without,
 * rather than claim "now" on every build. `changefreq` and `priority` are
 * left out: Google ignores both.
 *
 * Not listed: the dashboard, sign-in and sign-up, the API.
 */
type Stamp = 'plans' | 'legal' | null

export const PUBLIC_PAGES: readonly { path: string; stamp: Stamp }[] = [
  { path: '/', stamp: 'plans' },
  { path: '/pricing', stamp: 'plans' },
  { path: '/docs', stamp: null },
  { path: '/contact', stamp: null },
  { path: '/abuse', stamp: null },
  { path: '/legal', stamp: 'legal' },
  ...LEGAL_DOCUMENTS.map((document) => ({ path: document.href, stamp: 'legal' as const })),
]

export function buildSitemap(
  site: string,
  { plansUpdatedAt }: { plansUpdatedAt: string | null },
): MetadataRoute.Sitemap {
  // Midnight in Lagos on the day the drafts were written.
  const legal = new Date(`${BUSINESS.legalUpdatedOn}T00:00:00+01:00`)
  const plans = plansUpdatedAt === null ? null : new Date(plansUpdatedAt)
  const when = (stamp: Stamp): Date | null =>
    stamp === 'legal' ? legal : stamp === 'plans' ? plans : null

  return PUBLIC_PAGES.map(({ path, stamp }) => {
    const lastModified = when(stamp)
    return {
      url: new URL(path, site).toString(),
      ...(lastModified ? { lastModified } : {}),
    }
  })
}
