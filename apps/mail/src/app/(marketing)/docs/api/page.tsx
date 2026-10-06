import { BracketsCurly, Code, ListChecks } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame } from '@/features/api/docs/docs-frame'
import { ApiReference } from '@/features/api/docs/reference'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'API reference',
  description:
    'Every endpoint of the MyDomainsHub Mail API, with its fields, answers and errors, generated from the schemas the API validates with.',
  path: '/docs/api',
})

/** The reference (MAIL-SPEC §6): generated from the API's own schemas, as the OpenAPI document is. */
export default function ApiReferencePage() {
  return (
    <DocsFrame
      slug="api"
      icons={[Code, BracketsCurly, ListChecks]}
      intro={
        <p>
          Every endpoint, generated from the same schemas the API checks requests with. The same
          description, as OpenAPI 3.1: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.
        </p>
      }
    >
      <p className="mt-0!">
        Paths are under <code>{BUSINESS.apiBase}</code>. Send{' '}
        <code>Authorization: Bearer mdh_live_…</code> and, with a body,{' '}
        <code>Content-Type: application/json</code>. Errors are described in{' '}
        <Link href="/docs/errors">Errors</Link>; limits in <Link href="/docs/limits">Limits</Link>.
      </p>
      <ApiReference />
    </DocsFrame>
  )
}
