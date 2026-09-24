import type { MetadataRoute } from 'next'
import { listExtensionPages } from '@/features/extensions/queries/extension'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { buildSitemap } from '@/features/seo/lib/sitemap'
import { env } from '@/lib/env'

/**
 * sitemap.xml: every public page and every extension page. Read from the
 * same cached catalogue as the pages, so it changes when they do. About 700
 * addresses — one file holds 50,000.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [extensions, priced] = await Promise.all([listExtensionPages(), getPricedCatalogue()])
  return buildSitemap(env.NEXT_PUBLIC_APP_URL, {
    extensions: extensions?.map((entry) => entry.tld) ?? [],
    pricesFrom: priced?.rateUpdatedAt ?? null,
  })
}
