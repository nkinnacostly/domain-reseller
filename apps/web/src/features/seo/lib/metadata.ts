import type { Metadata } from 'next'
import { BRAND_NAME } from '@/components/layout/brand'

/**
 * The share card every page uses (app/opengraph-image.png). Named here
 * because a page that sets its own `openGraph` replaces the root's whole
 * object — image, site name and locale included — rather than merging into it.
 */
export const SHARE_IMAGE = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: `${BRAND_NAME} — domain names, priced in naira, with the renewal price shown upfront.`,
} as const

/** Search engines may show long snippets and large image previews (Google's robots meta rules). */
export const INDEXABLE: Metadata['robots'] = {
  index: true,
  follow: true,
  googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
}

/** Pages that are useful to visit but not to find in search: results, carts, one-time flows. */
export const NOT_INDEXED: Metadata['robots'] = { index: false, follow: true }

/** The panel: behind sign-in, nothing for a crawler to read or follow. */
export const PRIVATE: Metadata['robots'] = { index: false, follow: false }

/**
 * A public page's metadata: its canonical address (query strings and
 * variants collapse onto `path`), and a share card that keeps the site name,
 * locale and image. Titles take the root template (`%s · MyDomainsHub`).
 */
export function pageMetadata({
  title,
  description,
  path,
  robots,
}: {
  title?: Metadata['title']
  description?: string
  path: string
  robots?: Metadata['robots']
}): Metadata {
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      siteName: BRAND_NAME,
      locale: 'en_NG',
      url: path,
      images: [SHARE_IMAGE],
    },
    ...(robots === undefined ? {} : { robots }),
  }
}
