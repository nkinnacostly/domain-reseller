import Link from 'next/link'
import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Pager } from '@/features/admin/components/table/pager'
import {
  COMPLIANCE_NOTE,
  NO_NOTICE_MATCH,
  NO_NOTICES,
  NO_NOTICES_BODY,
  NOTICE_STATUS_LABEL,
  NOTICES_ERROR,
  noticeCount,
  noticeTypeLabel,
  noticeWindow,
  STATS_ERROR,
  sideWord,
} from '@/features/admin/lib/emails-copy'
import {
  emailsHref,
  emailsTabHref,
  isEmailsFiltered,
  type NoticeParams,
  type NoticeSort,
} from '@/features/admin/lib/emails-params'
import { formatWatDate } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { toneOf } from '@/features/admin/lib/tone'
import {
  type EmailStats,
  getEmailStats,
  type Listed,
  listNotices,
  type NoticeRow,
} from '@/features/admin/queries/emails'
import type { AdminPrincipal } from '@/features/admin/queries/session'
import { NoticeFilters, SortLinks } from './email-filters'
import { LINK, Masked, Note, QUIET_LINK, RelatedLinks, When } from './email-parts'
import { NoticeFigures } from './email-stats'

/**
 * The ERRP expiry notices sent on this side (docs/ADMIN-SPEC.md §5.2, B11;
 * PRD §7.4, FR-ERRP-1), from `admin_compliance_notices_v`. Read only: a
 * notice is a compliance record, kept three years and never edited or
 * deleted (CLAUDE.md §15), so this tab offers no action of any kind. The
 * recipient is masked in SQL.
 */

const SORTS: { value: NoticeSort; label: string }[] = [
  { value: 'sent', label: 'Sent' },
  { value: 'expires', label: 'Domain expiry' },
]

/** The domain the notice was about: by id when we still hold it, else its name alone. */
function DomainCell({ row }: { row: NoticeRow }) {
  const name = row.domainName || 'A domain'
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-notice-id={row.id}>
      {row.domainId ? (
        <Link href={adminHref.domain(row.domainId)} className={LINK}>
          {name}
        </Link>
      ) : (
        <span className="break-all">{name}</span>
      )}
      {row.testMode ? <TestBadge /> : null}
    </span>
  )
}

function NoticeCell({ row }: { row: NoticeRow }) {
  const when = noticeWindow(row.noticeType)
  return (
    <span className="inline-flex flex-col">
      <span>{noticeTypeLabel(row.noticeType)}</span>
      {when ? <span className="text-xs text-muted-foreground">Sent {when}</span> : null}
    </span>
  )
}

export function noticeColumns(): Column<NoticeRow, NoticeSort>[] {
  return [
    { key: 'domain', header: 'Domain', cell: (row) => <DomainCell row={row} /> },
    { key: 'notice', header: 'Notice', cell: (row) => <NoticeCell row={row} /> },
    {
      key: 'expires',
      header: 'Domain expiry',
      sort: 'expires',
      cell: (row) => formatWatDate(row.expiresAt),
    },
    { key: 'sent', header: 'Sent', sort: 'sent', cell: (row) => <When at={row.sentAt} /> },
    {
      key: 'recipient',
      header: 'To (masked)',
      cell: (row) => <Masked value={row.maskedRecipient} />,
    },
    { key: 'template', header: 'Template', cell: (row) => row.templateVersion ?? '—' },
    {
      key: 'delivery',
      header: 'Delivery',
      cell: (row) => (
        <AdminStatusPill
          value={row.deliveryStatus}
          labels={NOTICE_STATUS_LABEL}
          tone={row.deliveryStatus === 'sent' ? 'info' : toneOf(row.deliveryStatus)}
        />
      ),
    },
    {
      key: 'checked',
      header: 'Report read',
      cell: (row) => <When at={row.checkedAt} none="Not yet" />,
    },
    { key: 'account', header: 'Account', cell: (row) => <RelatedLinks userId={row.userId} /> },
  ]
}

export function NoticeList({
  side,
  params,
  list,
}: {
  side: AdminSide
  params: NoticeParams
  /** null: the read failed. */
  list: Listed<NoticeRow> | null
}) {
  if (!list) return <ErrorState title={NOTICES_ERROR} />
  const pages = pageCount(list.total, params.per)
  let body: React.ReactNode
  if (list.total === 0) {
    body = isEmailsFiltered(params) ? (
      <EmptyState
        title={NO_NOTICE_MATCH}
        body="Change or clear the filters to see more."
        action={
          <Link href={emailsTabHref('compliance')} className={QUIET_LINK}>
            Show every notice
          </Link>
        }
      />
    ) : (
      <EmptyState title={NO_NOTICES(side)} body={NO_NOTICES_BODY} />
    )
  } else if (list.rows.length === 0) {
    body = (
      <EmptyState
        title={`Nothing on page ${params.page}.`}
        body={`The list has ${pages} ${pages === 1 ? 'page' : 'pages'}.`}
        action={
          <Link href={emailsHref(params, { page: 1 })} className={QUIET_LINK}>
            Go to the first page
          </Link>
        }
      />
    )
  } else {
    body = (
      <DataTable<NoticeRow, NoticeSort>
        caption={`Expiry notices sent on the ${sideWord(side)} side, page ${params.page} of ${pages}`}
        rows={list.rows}
        columns={noticeColumns()}
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
        <SortLinks label="Sort notices" params={params} sorts={SORTS} />
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

export async function ComplianceTab({
  admin,
  side,
  params,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: NoticeParams
}) {
  const [stats, listed] = await Promise.all([
    getEmailStats(side).catch((): EmailStats | null => null),
    listNotices(admin, side, params).catch(() => ({ ok: false as const })),
  ])
  const list = listed.ok ? listed : null
  return (
    <>
      <Note testId="emails-compliance-note">{COMPLIANCE_NOTE}</Note>
      {stats ? <NoticeFigures stats={stats} /> : <ErrorState title={STATS_ERROR} />}
      <Panel labelledBy="notices-find-heading" className="space-y-4">
        <h2 id="notices-find-heading" className={PANEL_HEADING}>
          Find notices
        </h2>
        <NoticeFilters params={params} />
      </Panel>
      <section aria-labelledby="notices-list-heading" className="space-y-3">
        <h2 id="notices-list-heading" className="px-1 font-medium text-foreground">
          {list ? noticeCount(list.total) : 'Notices'}
        </h2>
        <NoticeList side={side} params={params} list={list} />
      </section>
    </>
  )
}
