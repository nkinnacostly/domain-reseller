import { EMAIL_STATUSES, SEND_EVENTS } from '@dr/shared/mail'
import { ArrowsLeftRight, Flag, ListChecks } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, DocsSection, DocsTable } from '@/features/api/docs/docs-frame'
import { STATUS_DOCS } from '@/features/api/docs/statuses'
import { EVENT_WORDS } from '@/features/emails/lib/words'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Statuses and events',
  description:
    'What each email status means in the MyDomainsHub Mail API, and how Amazon SES’s events move an email along.',
  path: '/docs/statuses',
})

/** Statuses and events (MAIL-SPEC §6): the lists are the API's own. */
export default function StatusesPage() {
  return (
    <DocsFrame
      slug="statuses"
      icons={[Flag, ArrowsLeftRight, ListChecks]}
      intro={
        <p>
          An email goes <code>queued → sending → sent → delivered</code>, or ends{' '}
          <code>bounced</code>, <code>complained</code>, <code>failed</code>,{' '}
          <code>suppressed</code> or <code>canceled</code>.
        </p>
      }
    >
      <DocsSection id="statuses" title="Statuses">
        <DocsTable
          label="Every status"
          head={['status', 'Means']}
          rows={EMAIL_STATUSES.map((status) => [
            <code key="status">{status}</code>,
            STATUS_DOCS[status],
          ])}
        />
      </DocsSection>

      <DocsSection id="events" title="Events">
        <p>
          Amazon SES reports what happens after it accepts an email. Each report is an event, shown
          on the email’s page in the dashboard, and the latest is <code>last_event</code> in{' '}
          <code>GET /emails/{'{id}'}</code>.
        </p>
        <DocsTable
          label="Every event"
          head={['last_event', 'Means']}
          rows={SEND_EVENTS.map((event) => [
            <code key="event">{event}</code>,
            EVENT_WORDS[event].detail,
          ])}
        />
      </DocsSection>

      <DocsSection id="order" title="When events arrive out of order">
        <ul>
          <li>A status never goes back: a late delivery report does not undo a bounce.</li>
          <li>
            <code>bounced</code> and <code>failed</code> beat <code>complained</code>, which beats{' '}
            <code>delivered</code>, which beats <code>sent</code>.
          </li>
          <li>
            A complaint is recorded, and moves a delivered email to <code>complained</code>, but it
            is not a bounce.
          </li>
          <li>
            A delay (<code>delivery_delay</code>) is an event, not a status: the email keeps its
            status while Amazon SES keeps trying.
          </li>
          <li>The same event reported twice is kept once.</li>
        </ul>
        <p>
          Read an email’s status with <Link href="/docs/api#getEmail">GET /emails/{'{id}'}</Link>,
          or many with <Link href="/docs/api#listEmails">GET /emails</Link>.
        </p>
      </DocsSection>
    </DocsFrame>
  )
}
