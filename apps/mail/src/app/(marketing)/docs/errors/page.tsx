import { API_ERROR_NAMES, API_ERROR_STATUS } from '@dr/shared/mail'
import { BugBeetle, Warning, Wrench } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import { DocsFrame, DocsSection, DocsTable } from '@/features/api/docs/docs-frame'
import { ERROR_DOCS } from '@/features/api/docs/errors'
import { CodeSample } from '@/features/marketing/components/code-sample'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Errors',
  description:
    'How the MyDomainsHub Mail API answers when it refuses a request: the error shape, each name and status, and what to do.',
  path: '/docs/errors',
})

const EXAMPLE = JSON.stringify(
  {
    name: 'validation_error',
    message: 'to: Not an email address, or "Name <address>"',
  },
  null,
  2,
)

/** Errors (MAIL-SPEC §6): the names and statuses come from the API's own table. */
export default function ErrorsPage() {
  return (
    <DocsFrame
      slug="errors"
      icons={[Warning, Wrench, BugBeetle]}
      intro={
        <p>
          A refused request answers JSON with a <code>name</code> you can test for and a{' '}
          <code>message</code> a person can read.
        </p>
      }
    >
      <DocsSection id="shape" title="The shape">
        <CodeSample className="mt-4" label="An error" code={EXAMPLE} />
        <p>
          The <code>message</code> says what happened and what to change. It never quotes an
          address, a subject, a body or a key you sent. Every answer, error or not, carries an{' '}
          <code>x-request-id</code> header: quote it when you write to{' '}
          <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a>. A <code>429</code> carries{' '}
          <code>retry-after</code>, in seconds.
        </p>
      </DocsSection>

      <DocsSection id="names" title="Every name">
        <DocsTable
          label="Error names"
          head={['name', 'Status', 'When', 'What to do']}
          rows={API_ERROR_NAMES.map((name) => [
            <code key="name">{name}</code>,
            <code key="status">{API_ERROR_STATUS[name]}</code>,
            ERROR_DOCS[name].when,
            ERROR_DOCS[name].next,
          ])}
        />
      </DocsSection>

      <DocsSection id="retry" title="What to send again">
        <ul>
          <li>
            <code>rate_limited</code>, <code>quota_exceeded</code> and <code>internal_error</code>{' '}
            may succeed later: wait as <code>retry-after</code> says, then send again with the same{' '}
            <code>Idempotency-Key</code>, so a request that did get through is not sent twice.
          </li>
          <li>
            A network error or a timeout leaves you not knowing: send again with the same key — the
            first answer comes back if the first request arrived.
          </li>
          <li>Every other error needs a change to the request first.</li>
        </ul>
      </DocsSection>
    </DocsFrame>
  )
}
