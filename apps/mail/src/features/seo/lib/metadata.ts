import type { Metadata } from 'next'
import { PRODUCT_NAME } from '@/components/layout/brand'
import { LAUNCH } from '@/features/marketing/lib/site'

/**
 * The share card every public page uses (app/opengraph-image.png). Named
 * here because a page that sets its own `openGraph` replaces the root's
 * whole object — image, site name and locale included — rather than merging
 * into it (CLAUDE.md §15, as the shop learned).
 */
export const SHARE_IMAGE = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: `${PRODUCT_NAME} — transactional email for Nigerian businesses, priced in naira.`,
} as const

/** Search engines may show long snippets and large image previews. */
export const INDEXABLE: Metadata['robots'] = {
  index: true,
  follow: true,
  googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
}

/** Before launch (MAIL-SPEC §13, P4): nothing public is indexed. */
export const NOT_YET_INDEXED: Metadata['robots'] = { index: false, follow: false }

/** The robots rule every public page takes, from the one launch switch. */
export const publicRobots = (isOpen: boolean = LAUNCH.isOpen): Metadata['robots'] =>
  isOpen ? INDEXABLE : NOT_YET_INDEXED

/**
 * A public page's metadata: its canonical address, a complete share card,
 * and the launch switch's robots rule. Titles take the root template
 * (`%s · MyDomainsHub Mail`); `absolute` skips it, for the home page.
 */
export function pageMetadata({
  title,
  description,
  path,
  absolute = false,
}: {
  title: string
  description: string
  path: string
  absolute?: boolean
}): Metadata {
  return {
    title: absolute ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      siteName: PRODUCT_NAME,
      locale: 'en_NG',
      url: path,
      title: absolute ? title : `${title} · ${PRODUCT_NAME}`,
      description,
      images: [SHARE_IMAGE],
    },
    twitter: { card: 'summary_large_image', images: [SHARE_IMAGE.url] },
    robots: publicRobots(),
  }
}
