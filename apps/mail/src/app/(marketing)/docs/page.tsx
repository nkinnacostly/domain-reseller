import { ArrowRight } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, DocsSection, DocsTable } from '@/features/api/docs/docs-frame'
import { DOCS_PAGES } from '@/features/api/docs/pages'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Docs',
  description:
    'Send transactional email with one HTTP call: the quickstart, the API reference, errors, limits, idempotency, scheduling and statuses.',
  path: '/docs',
})

/** The docs' front page (MAIL-SPEC §6 "Docs"): what the API is, and every guide. */
export default function DocsPage() {
  return (
    <DocsFrame
      slug=""
      title="Documentation"
      intro={
        <p>
          The MyDomainsHub Mail API sends transactional email — receipts, sign-in links, alerts —
          from your own domain, with one HTTP call. JSON in and out; no SDK needed.
        </p>
      }
    >
      <div className="rounded-3xl border border-brand-subtle-border bg-brand-subtle p-6 sm:p-8">
        <h2 className="text-xl font-semibold tracking-tight">Start here</h2>
        <p>The quickstart takes you from a verified domain to your first email.</p>
        <Link
          href="/docs/quickstart"
          className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground! no-underline! transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
        >
          Read the quickstart
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>

      <DocsSection id="basics" title="The basics">
        <DocsTable
          label="Address, keys and format"
          head={['What', 'How']}
          rows={[
            ['Base address', <code key="base">{BUSINESS.apiBase}</code>],
            [
              'Authentication',
              <span key="auth">
                <code>Authorization: Bearer mdh_live_…</code>, a key from the dashboard
              </span>,
            ],
            ['Format', 'JSON in and out, UTF-8'],
            [
              'Errors',
              <span key="errors">
                <code>{'{ "name", "message" }'}</code> with the status — see{' '}
                <Link href="/docs/errors">Errors</Link>
              </span>,
            ],
            [
              'Every answer',
              <span key="id">
                carries <code>x-request-id</code>: quote it when you write to us
              </span>,
            ],
            [
              'Described',
              <span key="openapi">
                <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>, OpenAPI 3.1
              </span>,
            ],
          ]}
        />
      </DocsSection>

      <DocsSection id="guides" title="Every guide">
        <ul className="list-none! space-y-3! pl-0!">
          {DOCS_PAGES.filter((page) => page.slug !== '').map((page) => (
            <li key={page.href}>
              <Link href={page.href}>{page.title}</Link>
              <span className="text-muted-foreground"> — {page.summary}</span>
            </li>
          ))}
        </ul>
      </DocsSection>
    </DocsFrame>
  )
}
