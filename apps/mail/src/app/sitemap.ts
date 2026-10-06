import type { MetadataRoute } from 'next'
import { getPlanCatalogue } from '@/features/pricing/queries/plans'
import { buildSitemap } from '@/features/seo/lib/sitemap'
import { env } from '@/lib/env'

/**
 * sitemap.xml: the public pages, dated only where the date is true (legal
 * drafts, and the plan rows behind the pages that show them). Read from the
 * same cached plans as the pages, so it changes when they do.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const catalogue = await getPlanCatalogue()
  return buildSitemap(env.NEXT_PUBLIC_MAIL_URL, {
    plansUpdatedAt: catalogue?.updatedAt ?? null,
  })
}
