import type { EmailRow } from '@dr/shared/mail'
import { ChevronRight, Clock } from 'lucide-react'
import Link from 'next/link'
import { EmailStatusPill } from '@/components/common/email-status'
import { lagosTime } from '../lib/format'
import { EVENT_WORDS, isScheduled } from '../lib/words'

/**
 * The log's rows (MAIL-SPEC §10 Emails): each email's status in words, its
 * subject, first recipient, when it was queued — or when it will go, if
 * scheduled — and the last thing Amazon SES said about it. A row opens the
 * email's own page.
 */

function recipients(email: EmailRow): string {
  const everyone = [...email.to, ...email.cc, ...email.bcc]
  const first = everyone[0] ?? ''
  return everyone.length > 1 ? `${first} and ${everyone.length - 1} more` : first
}

export function EmailLog({ emails }: { emails: EmailRow[] }) {
  return (
    <ul
      aria-label="Emails"
      className="divide-y divide-border rounded-3xl border border-border bg-card"
    >
      {emails.map((email) => {
        const scheduled = isScheduled(email)
        return (
          <li key={email.id} data-email={email.id}>
            <Link
              href={`/dashboard/emails/${email.id}`}
              className="group flex items-center gap-3 px-5 py-4 transition-colors first:rounded-t-3xl last:rounded-b-3xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-muted"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <EmailStatusPill status={email.status} />
                  {scheduled ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3.5" aria-hidden="true" />
                      Scheduled for {lagosTime(email.scheduled_at)}
                    </span>
                  ) : null}
                </div>
                <p className="truncate font-medium group-hover:underline">{email.subject}</p>
                <p className="truncate text-sm text-muted-foreground">To {recipients(email)}</p>
                <p className="text-xs text-muted-foreground">
                  Queued {lagosTime(email.created_at)}
                  {email.last_event && email.last_event_at
                    ? ` · ${EVENT_WORDS[email.last_event].label.toLowerCase()} ${lagosTime(email.last_event_at)}`
                    : ''}
                </p>
              </div>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
