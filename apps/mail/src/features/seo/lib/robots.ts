import type { MetadataRoute } from 'next'

/**
 * Who may crawl what (robots.txt). The public pages are open; closed are
 * the places with nothing for a crawler: the dashboard (it only redirects to
 * sign-in), the API (it answers API keys, not readers) and auth callbacks.
 * Whether a public page may be *indexed* is its own robots meta tag, set by
 * the launch switch (`pageMetadata`), so the two never contradict: a page a
 * crawler cannot fetch is a page whose noindex it cannot read.
 */
export const PRIVATE_PATHS = ['/dashboard', '/api/', '/auth/'] as const

export function robotsRules(site: string): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...PRIVATE_PATHS] }],
    sitemap: new URL('/sitemap.xml', site).toString(),
  }
}
