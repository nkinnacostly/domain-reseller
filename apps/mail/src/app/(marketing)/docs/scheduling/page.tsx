import { EMAIL_LIMITS } from '@dr/shared/mail'
import { CalendarCheck, Clock, XCircle } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsFrame, DocsSection } from '@/features/api/docs/docs-frame'
import { CodeSample } from '@/features/marketing/components/code-sample'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Scheduling',
  description:
    'Send an email later with scheduled_at, move it, or cancel it before it goes — the MyDomainsHub Mail API.',
  path: '/docs/scheduling',
})

const SEND = JSON.stringify(
  {
    from: 'Acme <reminders@acme.ng>',
    to: ['ada@example.com'],
    subject: 'Your appointment is tomorrow',
    text: 'See you at 10:00.',
    scheduled_at: '2026-10-07T09:00:00+01:00',
  },
  null,
  2,
)

const MOVE = [
  `curl -X PATCH ${BUSINESS.apiBase}/emails/6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d \\`,
  '  -H "Authorization: Bearer $MDH_API_KEY" \\',
  '  -H "Content-Type: application/json" \\',
  `  -d '{"scheduled_at": "2026-10-07T11:00:00+01:00"}'`,
].join('\n')

const CANCEL = [
  `curl -X POST ${BUSINESS.apiBase}/emails/6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d/cancel \\`,
  '  -H "Authorization: Bearer $MDH_API_KEY"',
].join('\n')

/** Scheduling (MAIL-SPEC §3.1): what migration 48's queue does with scheduled_at. */
export default function SchedulingPage() {
  return (
    <DocsFrame
      slug="scheduling"
      icons={[Clock, CalendarCheck, XCircle]}
      intro={
        <p>
          Give an email a <code>scheduled_at</code> and it waits in the queue until then. Until it
          goes, you can move it or cancel it.
        </p>
      }
    >
      <DocsSection id="later" title="Send later">
        <p>
          Add <code>scheduled_at</code> to <code>POST /emails</code>, or to any email of a batch: an
          ISO 8601 date and time with its zone (<code>Z</code> or <code>+01:00</code>), at most{' '}
          {EMAIL_LIMITS.maxScheduleHours} hours ahead. A time already past sends it straight away.
        </p>
        <CodeSample className="mt-4" label="A scheduled email" code={SEND} />
        <p>
          The answer is its id, as for any email; its status is <code>queued</code> until our sender
          takes it at that time. Everything is checked twice: when you queue it, and again when it
          goes — the domain still verified, the key not revoked, the account not paused, no
          recipient suppressed. If something changed, it is not sent, and its status says why.
        </p>
        <p>It counts against your caps on the day you queue it, not the day it goes.</p>
      </DocsSection>

      <DocsSection id="move" title="Move it">
        <p>
          <code>PATCH /emails/{'{id}'}</code> with a new <code>scheduled_at</code>, with a
          full-access key. The answer is the email’s id, status and new time.
        </p>
        <CodeSample className="mt-4" label="Moving an email" code={MOVE} />
      </DocsSection>

      <DocsSection id="cancel" title="Cancel it">
        <p>
          <code>POST /emails/{'{id}'}/cancel</code>, with a full-access key. Its recipients are
          given back to your caps and its body is deleted at once. Cancelling it again answers the
          same.
        </p>
        <CodeSample className="mt-4" label="Cancelling an email" code={CANCEL} />
      </DocsSection>

      <DocsSection id="when" title="Until when">
        <p>
          You can move or cancel an email while it waits in the queue — scheduled, or not yet picked
          up. Once our sender has tried it, it may already be on its way, so both answer{' '}
          <code>409</code> with the email’s status. An email sent without <code>scheduled_at</code>{' '}
          is picked up soon after it is queued, so in practice it is scheduled emails you cancel.
        </p>
        <p>
          The <Link href="/dashboard/emails">Emails</Link> log shows each scheduled email and when
          it is due.
        </p>
      </DocsSection>
    </DocsFrame>
  )
}
