import { env } from '@/lib/env'
import { breadcrumbLd, type Crumb, graph, type JsonLdNode } from '../lib/structured-data'

/**
 * Structured data for search engines and AI assistants. A server component:
 * the JSON is in the HTML a crawler reads, no script runs. `<` is escaped so
 * a value can never close the tag early.
 */
export function JsonLd({ data }: { data: JsonLdNode }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON, with `<` escaped — the pattern Next's docs give for JSON-LD.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  )
}

/**
 * A page's place in the site — Home, then `trail`, the last crumb being the
 * page itself — plus any other structured data the page carries.
 */
export function PageJsonLd({
  trail,
  extra = [],
}: {
  trail: readonly Crumb[]
  extra?: (JsonLdNode | null)[]
}) {
  const site = env.NEXT_PUBLIC_MAIL_URL
  const crumbs = trail.length === 0 ? [] : [{ name: 'Home', path: '/' }, ...trail]
  return <JsonLd data={graph(crumbs.length > 0 ? breadcrumbLd(site, crumbs) : null, ...extra)} />
}
