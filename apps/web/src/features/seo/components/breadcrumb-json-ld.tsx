import { JsonLd } from '@/components/common/json-ld'
import { env } from '@/lib/env'
import { breadcrumbLd, type Crumb, graph, type JsonLdNode } from '../lib/structured-data'

/**
 * A page's place in the site for search engines — Home, then `trail`, the
 * last crumb being the page itself — plus any other structured data it has.
 */
export function PageJsonLd({
  trail,
  extra = [],
}: {
  trail: Crumb[]
  extra?: (JsonLdNode | null)[]
}) {
  const site = env.NEXT_PUBLIC_APP_URL
  return (
    <JsonLd data={graph(breadcrumbLd(site, [{ name: 'Home', path: '/' }, ...trail]), ...extra)} />
  )
}
