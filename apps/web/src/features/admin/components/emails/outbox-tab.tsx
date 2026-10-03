import Link from 'next/link'
import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Pager } from '@/features/admin/components/table/pager'
import { canAct } from '@/features/admin/lib/actions'
import {
  CATEGORY_LABEL,
  emailCount,
  kindLabel,
  LIST_ERROR,
  NO_EMAILS,
  NO_EMAILS_BODY,
  NO_MATCH,
  OUTBOX_NOTE,
  OUTBOX_STATUS_LABEL,
  STATS_ERROR,
  sideWord,
  skipReasonText,
  TEST_SIDE_NOTE,
} from '@/features/admin/lib/emails-copy'
import {
  EMAILS_PATH,
  emailsHref,
  isEmailsFiltered,
  type OutboxParams,
  type OutboxSort,
} from '@/features/admin/lib/emails-params'
import { isUnconfirmed, sendAgainOffer } from '@/features/admin/lib/emails-rules'
import { formatCount, shortId } from '@/features/admin/lib/format'
import { EMAIL_STATUS_LABEL } from '@/features/admin/lib/labels'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  type EmailStats,
  getEmailStats,
  type Listed,
  listOutbox,
  type OutboxRow,
} from '@/features/admin/queries/emails'
import type { AdminPrincipal } from '@/features/admin/queries/session'
import { OutboxFilters, SortLinks } from './email-filters'
import { Masked, Note, QUIET_LINK, RelatedLinks, When } from './email-parts'
import { KindTable, OutboxFigures } from './email-stats'
import { SendAgain } from './send-again'

/**
 * The outbox (docs/ADMIN-SPEC.md §5.2, B11): every email the database
 * queued on this side, newest first, and what became of it. Recipients come
 * masked from `admin_email_outbox_v`, errors with their addresses replaced
 * (`last_error_safe`). The one action is "Send again" on a failed email.
 */

const SORTS: { value: OutboxSort; label: string }[] = [
  { value: 'created', label: 'Queued' },
  { value: 'sent', label: 'Sent' },
]

/** What the email is: its kind, the side, its category and template, and a short reference. */
function EmailCell({ row }: { row: OutboxRow }) {
  return (
    <span data-email-id={row.id} className="inline-flex min-w-0 flex-col gap-1">
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>{kindLabel(row.kind)}</span>
        {row.testMode ? <TestBadge /> : null}
      </span>
      <span className="text-xs font-normal text-muted-foreground">
        {CATEGORY_LABEL[row.category as keyof typeof CATEGORY_LABEL] ?? row.category}
        {row.templateVersion ? ` · template ${row.templateVersion}` : ''} · ref {shortId(row.id)}
      </span>
    </span>
  )
}

/** Where it stands: its status, then what the provider reported, in words (S8). */
function StatusCell({ row, now }: { row: OutboxRow; now: Date }) {
  return (
    <span className="inline-flex flex-wrap justify-end gap-1.5 sm:justify-start">
      <AdminStatusPill value={row.status} labels={EMAIL_STATUS_LABEL} />
      {row.deliveryStatus ? (
        <AdminStatusPill value={row.deliveryStatus} labels={EMAIL_STATUS_LABEL} />
      ) : null}
      {isUnconfirmed(row, now) ? (
        <AdminStatusPill
          value="unconfirmed"
          labels={{ unconfirmed: OUTBOX_STATUS_LABEL.unconfirmed }}
          tone="warning"
        />
      ) : null}
      {row.complainedAt ? (
        <AdminStatusPill
          value="complained"
          labels={{ complained: OUTBOX_STATUS_LABEL.complained }}
          tone="warning"
        />
      ) : null}
    </span>
  )
}

/** Why it was not sent: the error with its addresses replaced, or why it was skipped. */
function WhyCell({ row }: { row: OutboxRow }) {
  const why =
    row.status === 'skipped' ? skipReasonText(row.skipReason) : (row.lastErrorSafe ?? null)
  if (!why) return <span className="text-muted-foreground">—</span>
  return <span className="block max-w-sm text-xs break-words">{why}</span>
}

/** When it went, or when it is next tried. */
function SentCell({ row }: { row: OutboxRow }) {
  if (row.sentAt) return <When at={row.sentAt} />
  if ((row.status === 'pending' || row.status === 'sending') && row.nextAttemptAt) {
    return (
      <span className="inline-flex flex-col">
        <span className="text-xs text-muted-foreground">Next try</span>
        <When at={row.nextAttemptAt} />
      </span>
    )
  }
  return <span className="text-muted-foreground">Not sent</span>
}

export function outboxColumns({
  now,
  mayRequeue,
  returnTo,
}: {
  now: Date
  mayRequeue: boolean
  returnTo: string
}): Column<OutboxRow, OutboxSort>[] {
  return [
    { key: 'email', header: 'Email', cell: (row) => <EmailCell row={row} /> },
    { key: 'to', header: 'To (masked)', cell: (row) => <Masked value={row.maskedTo} /> },
    { key: 'status', header: 'Status', cell: (row) => <StatusCell row={row} now={now} /> },
    {
      key: 'created',
      header: 'Queued',
      sort: 'created',
      cell: (row) => <When at={row.createdAt} />,
    },
    { key: 'sent', header: 'Sent', sort: 'sent', cell: (row) => <SentCell row={row} /> },
    { key: 'attempts', header: 'Tries', numeric: true, cell: (row) => formatCount(row.attempts) },
    { key: 'why', header: 'Why not sent', cell: (row) => <WhyCell row={row} /> },
    {
      key: 'for',
      header: 'For',
      cell: (row) => (
        <RelatedLinks
          orderId={row.orderId}
          orderNumber={row.orderNumber}
          domainId={row.domainId}
          userId={row.userId}
        />
      ),
    },
    {
      key: 'action',
      header: 'Action',
      cell: (row) => {
        const offer = sendAgainOffer(row, mayRequeue)
        if (offer.offer) {
          return (
            <SendAgain
              emailId={row.id}
              kind={kindLabel(row.kind)}
              reference={shortId(row.id)}
              maskedTo={row.maskedTo}
              attempts={row.attempts}
              lastErrorSafe={row.lastErrorSafe}
              returnTo={returnTo}
            />
          )
        }
        return offer.why ? (
          <span className="text-xs text-muted-foreground">{offer.why}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
  ]
}

/** The list, its sort links and pages, in all four states (S11). */
export function OutboxList({
  admin,
  side,
  params,
  list,
  now,
}: {
  admin: Pick<AdminPrincipal, 'role' | 'testOnly'>
  side: AdminSide
  params: OutboxParams
  /** null: the read failed. */
  list: Listed<OutboxRow> | null
  now: Date
}) {
  if (!list) return <ErrorState title={LIST_ERROR} />
  const pages = pageCount(list.total, params.per)
  let body: React.ReactNode
  if (list.total === 0) {
    body = isEmailsFiltered(params) ? (
      <EmptyState
        title={NO_MATCH}
        body="Change or clear the filters to see more."
        action={
          <Link href={EMAILS_PATH} className={QUIET_LINK}>
            Show every email
          </Link>
        }
      />
    ) : (
      <EmptyState title={NO_EMAILS(side)} body={NO_EMAILS_BODY} />
    )
  } else if (list.rows.length === 0) {
    body = (
      <EmptyState
        title={`Nothing on page ${params.page}.`}
        body={`The list has ${pages} ${pages === 1 ? 'page' : 'pages'} now: emails may have moved on since the link was made.`}
        action={
          <Link href={emailsHref(params, { page: 1 })} className={QUIET_LINK}>
            Go to the first page
          </Link>
        }
      />
    )
  } else {
    body = (
      <DataTable<OutboxRow, OutboxSort>
        caption={`Emails on the ${sideWord(side)} side, page ${params.page} of ${pages}`}
        rows={list.rows}
        columns={outboxColumns({
          now,
          mayRequeue: canAct(admin, 'email.requeue'),
          returnTo: emailsHref(params),
        })}
        rowKey={(row) => row.id}
        sorting={{
          sort: params.sort,
          dir: params.dir,
          href: (sort) => emailsHref(params, nextSort(params, sort)),
        }}
        empty={null}
      />
    )
  }
  return (
    <div className="space-y-3">
      {list.rows.length > 0 ? (
        <SortLinks label="Sort emails" params={params} sorts={SORTS} />
      ) : null}
      {body}
      {list.total > 0 ? (
        <Pager
          page={params.page}
          pageCount={pages}
          total={list.total}
          href={(page) => emailsHref(params, { page })}
        />
      ) : null}
    </div>
  )
}

export async function OutboxTab({
  admin,
  side,
  params,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: OutboxParams
  now: Date
}) {
  const [stats, listed] = await Promise.all([
    getEmailStats(side).catch((): EmailStats | null => null),
    listOutbox(admin, side, params, now).catch(() => ({ ok: false as const })),
  ])
  const list = listed.ok ? listed : null
  return (
    <>
      <Note testId="emails-outbox-note">{OUTBOX_NOTE}</Note>
      {side === 'test' ? <Note testId="emails-test-side-note">{TEST_SIDE_NOTE}</Note> : null}
      {stats ? <OutboxFigures stats={stats} params={params} /> : <ErrorState title={STATS_ERROR} />}
      <Panel labelledBy="emails-find-heading" className="space-y-4">
        <h2 id="emails-find-heading" className={PANEL_HEADING}>
          Find emails
        </h2>
        <OutboxFilters params={params} />
      </Panel>
      <section aria-labelledby="emails-list-heading" className="space-y-3">
        <h2 id="emails-list-heading" className="px-1 font-medium text-foreground">
          {list ? emailCount(list.total) : 'Emails'}
        </h2>
        <OutboxList admin={admin} side={side} params={params} list={list} now={now} />
      </section>
      {stats ? <KindTable stats={stats} params={params} /> : null}
    </>
  )
}
