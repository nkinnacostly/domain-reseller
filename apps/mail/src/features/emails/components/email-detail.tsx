import { FileX } from 'lucide-react'
import type { MemberRole } from '@/lib/safe-action'
import { cn } from '@/lib/utils'
import { lagosTime, lagosTimeWithSeconds } from '../lib/format'
import { bodyKeptUntil, type TimelineItem } from '../lib/timeline'
import type { EmailDetail, EmailPayload } from '../queries/log'

/**
 * The email page's parts (MAIL-SPEC §10 Email): the timeline, the
 * recipients, the headers we set, and the body while it is kept (MR3).
 * Server components; every address shown is the account's own data, to its
 * own members (MR4).
 */

export const card = 'rounded-3xl border border-border bg-card p-5 sm:p-6'

const DOT: Record<TimelineItem['tone'], string> = {
  success: 'bg-tone-success-foreground',
  warning: 'bg-tone-warning-foreground',
  danger: 'bg-tone-danger-foreground',
  info: 'bg-tone-info-foreground',
  neutral: 'bg-muted-foreground',
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="space-y-5">
      {items.map((item) => (
        <li key={item.key} data-event={item.label} className="relative flex gap-3">
          <span
            aria-hidden="true"
            className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', DOT[item.tone])}
          />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="font-medium">{item.label}</span>
              <time dateTime={item.at} className="text-xs tabular-nums text-muted-foreground">
                {lagosTimeWithSeconds(item.at)}
              </time>
            </p>
            {item.detail ? (
              <p className="mt-0.5 text-pretty text-sm/6 text-muted-foreground">{item.detail}</p>
            ) : null}
            {item.bounce ? (
              <div className="mt-2 space-y-1.5 rounded-2xl bg-tone-danger px-4 py-3 text-sm/6 text-tone-danger-foreground">
                <p className="font-medium">{item.bounce.summary}</p>
                {item.bounce.serverSaid ? (
                  <p className="break-words">
                    The receiving server said:{' '}
                    <span className="font-mono text-xs">{item.bounce.serverSaid}</span>
                  </p>
                ) : null}
                {item.bounce.kind ? (
                  <p className="text-xs">Amazon SES’s bounce type: {item.bounce.kind}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

function AddressList({ label, addresses }: { label: string; addresses: string[] }) {
  if (addresses.length === 0) return null
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1">
        <ul className="space-y-0.5 text-sm">
          {addresses.map((address) => (
            <li key={address} className="break-all">
              {address}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  )
}

export function Recipients({ email }: { email: EmailDetail }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      <AddressList label="To" addresses={email.to_addresses} />
      <AddressList label="Cc" addresses={email.cc_addresses} />
      <AddressList label="Bcc (not in the headers)" addresses={email.bcc_addresses} />
      <AddressList label="Reply-To" addresses={email.reply_to} />
    </dl>
  )
}

/**
 * The headers this email was given: the ones we set from the request, and
 * the request's own extra headers while its body is kept. Bcc is never a
 * header. Tags travel to Amazon SES with the email, not in it.
 */
export function HeadersList({
  email,
  payload,
}: {
  email: EmailDetail
  payload: EmailPayload | null
}) {
  const rows: [string, string][] = [
    ['From', email.from_address],
    ['To', email.to_addresses.join(', ')],
    ...(email.cc_addresses.length
      ? ([['Cc', email.cc_addresses.join(', ')]] as [string, string][])
      : []),
    ...(email.reply_to.length
      ? ([['Reply-To', email.reply_to.join(', ')]] as [string, string][])
      : []),
    ['Subject', email.subject],
    ...Object.entries(payload?.headers ?? {}),
  ]
  return (
    <div className="space-y-3">
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box takes focus so a keyboard can scroll it (WCAG 2.1.1)
        tabIndex={0}
        aria-label="Headers"
        className="relative overflow-x-auto rounded-2xl border border-border bg-background focus-visible:outline-2 focus-visible:outline-ring"
      >
        <dl className="w-max min-w-full divide-y divide-border font-mono text-xs/5">
          {rows.map(([name, value]) => (
            <div key={name} className="flex gap-3 px-4 py-2">
              <dt className="shrink-0 font-semibold">{name}:</dt>
              <dd className="whitespace-pre">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      {payload ? null : (
        <p className="text-xs/5 text-muted-foreground">
          Extra headers from the request are kept with the body, so they are not shown here.
        </p>
      )}
      {email.tags.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Tags</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {email.tags.map((tag) => (
              <li key={tag.name} className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-xs">
                {tag.name}: {tag.value}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {email.ses_message_id ? (
        <p className="break-all text-xs text-muted-foreground">
          Amazon SES message id: <span className="font-mono">{email.ses_message_id}</span>
        </p>
      ) : null}
    </div>
  )
}

function Source({ label, code }: { label: string; code: string }) {
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box takes focus so a keyboard can scroll it (WCAG 2.1.1)
      tabIndex={0}
      aria-label={label}
      className="relative max-h-96 overflow-auto rounded-2xl border border-border bg-background focus-visible:outline-2 focus-visible:outline-ring"
    >
      <pre className="w-max min-w-full px-4 py-3 font-mono text-xs/5">{code}</pre>
    </section>
  )
}

/**
 * The body (MR3): kept 72 hours after the email leaves the queue, for owners,
 * admins and developers. Shown as its source — never rendered here, so
 * nothing in it runs or loads from anywhere.
 */
export function BodyView({
  email,
  payload,
  memberRole,
}: {
  email: EmailDetail
  payload: EmailPayload | null
  memberRole: MemberRole
}) {
  const until = bodyKeptUntil(email)
  if (memberRole === 'viewer') {
    return (
      <p className="text-pretty text-sm/6 text-muted-foreground">
        Viewers cannot read email bodies. Owners, admins and developers can, for 72 hours after an
        email is sent.
      </p>
    )
  }
  if (!payload) {
    const why =
      email.status === 'suppressed'
        ? 'No body was kept: this email was never going to be sent.'
        : email.status === 'canceled'
          ? 'Its body was deleted when it was canceled.'
          : 'Deleted after 72 hours. We keep a body for 72 hours after sending, then delete it.'
    return (
      <p className="flex gap-2.5 text-pretty text-sm/6 text-muted-foreground">
        <FileX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {why}
      </p>
    )
  }
  return (
    <div className="space-y-4">
      <p className="text-pretty text-sm/6 text-muted-foreground">
        {until
          ? `Kept until ${lagosTime(until)}, then deleted within the hour.`
          : 'Kept until 72 hours after it is sent, then deleted.'}
      </p>
      {payload.text ? (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Text</h3>
          <Source label="The text body" code={payload.text} />
        </div>
      ) : null}
      {payload.html ? (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">HTML, as sent</h3>
          <Source label="The HTML body’s source" code={payload.html} />
        </div>
      ) : null}
    </div>
  )
}
