/**
 * The docs (MAIL-SPEC §6 "Docs"), in reading order. `stub` marks a page whose
 * guide another package writes — webhooks (the events package) and DNS
 * set-up (the domains package): it says so plainly, and claims nothing the
 * product does not do yet (N9b).
 */

export type DocsPage = {
  slug: string
  href: string
  title: string
  summary: string
  stub?: true
}

export const DOCS_PAGES: readonly DocsPage[] = [
  {
    slug: '',
    href: '/docs',
    title: 'Overview',
    summary: 'What the API does, and where each guide is.',
  },
  {
    slug: 'quickstart',
    href: '/docs/quickstart',
    title: 'Quickstart',
    summary: 'From a verified domain to your first email, with curl, Node, Python or PHP.',
  },
  {
    slug: 'api',
    href: '/docs/api',
    title: 'API reference',
    summary: 'Every endpoint, its fields and its answers, generated from the API’s own schemas.',
  },
  {
    slug: 'errors',
    href: '/docs/errors',
    title: 'Errors',
    summary: 'The error shape, each name and status, and what to do about it.',
  },
  {
    slug: 'limits',
    href: '/docs/limits',
    title: 'Limits',
    summary: 'Per email, per request, per key and per plan.',
  },
  {
    slug: 'idempotency',
    href: '/docs/idempotency',
    title: 'Idempotency',
    summary: 'Retry safely: the same request with the same key sends once.',
  },
  {
    slug: 'scheduling',
    href: '/docs/scheduling',
    title: 'Scheduling',
    summary: 'Send later, move it, or cancel it before it goes.',
  },
  {
    slug: 'statuses',
    href: '/docs/statuses',
    title: 'Statuses and events',
    summary: 'What each status means, and how events move an email along.',
  },
  {
    slug: 'webhooks',
    href: '/docs/webhooks',
    title: 'Webhooks',
    summary: 'Events sent to your own server. The guide is being written.',
    stub: true,
  },
  {
    slug: 'domains',
    href: '/docs/domains',
    title: 'Domains and DNS',
    summary: 'Verifying the domain you send from. Being written.',
    stub: true,
  },
]

export function docsPage(slug: string): DocsPage {
  const page = DOCS_PAGES.find((one) => one.slug === slug)
  if (!page) throw new Error(`no docs page ${slug}`)
  return page
}
