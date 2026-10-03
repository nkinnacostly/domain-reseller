import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Pager } from '@/features/admin/components/table/pager'
import {
  AUDIT_TEST_ADMIN_NOTE,
  actionLabel,
  gatewayResult,
  NO_DETAIL,
  SIDE_LABEL,
  targetLabel,
} from '@/features/admin/lib/audit-copy'
import {
  AUDIT_PATH,
  type AuditParams,
  type AuditSort,
  auditFiltersActive,
  auditHref,
} from '@/features/admin/lib/audit-params'
import { auditTargetHref, auditTargetText } from '@/features/admin/lib/audit-target'
import { adminErrorWords } from '@/features/admin/lib/errors'
import { formatWat, formatWatDate, formatWatTime, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { AUDIT_OUTCOME_LABEL, labelFor, ROLE_LABEL } from '@/features/admin/lib/labels'
import { pageCount } from '@/features/admin/lib/list-params'
import type { AuditEntry } from '@/features/admin/queries/audit'
import { cn } from '@/lib/utils'
import { RedactReason } from './redact-reason'

/**
 * The entries (docs/ADMIN-SPEC.md §5.2 B14): When · Admin · Action · Target
 * · Side · Reason · Result · Request id, and a `<details>` per entry with what
 * was recorded. An intent note shows the gateway's result beside it. The one
 * control is the owner's "Redact reason", which removes a typed reason and
 * records that it did; nothing edits or deletes an entry.
 */

const LINK = cn(
  'inline-flex min-h-11 items-center rounded text-foreground underline-offset-4 hover:underline active:opacity-80',
  FOCUS,
)

function When({ row }: { row: AuditEntry }) {
  return (
    <span className="block min-w-0">
      <time dateTime={row.createdAt} className="block">
        <span className="whitespace-nowrap">{formatWatDate(row.createdAt)},</span>{' '}
        <span className="whitespace-nowrap">{formatWatTime(row.createdAt)}</span>
      </time>
      <Link href={adminHref.audit(row.id)} className={cn(LINK, 'font-normal text-sm')}>
        Entry #{row.id}
      </Link>
    </span>
  )
}

function Admin({ row, params }: { row: AuditEntry; params: AuditParams }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 sm:flex-col sm:items-start">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Link
          href={auditHref(params, { admin: row.adminLabel, id: null })}
          className={cn(LINK, 'whitespace-nowrap')}
        >
          {row.adminLabel}
          <span className="sr-only">: only this admin’s entries</span>
        </Link>
        {row.testActor ? <TestBadge /> : null}
      </span>
      <span className="text-xs text-muted-foreground">{labelFor(ROLE_LABEL, row.adminRole)}</span>
    </span>
  )
}

function Action({ row }: { row: AuditEntry }) {
  return (
    <span className="block min-w-0">
      <span className="block">{actionLabel(row.action)}</span>
      <code className="font-mono text-xs break-words text-muted-foreground">{row.action}</code>
    </span>
  )
}

function Target({ row }: { row: AuditEntry }) {
  const target = { type: row.targetType, id: row.targetId }
  const text = auditTargetText(target)
  const href = auditTargetHref(target)
  return href ? (
    <Link href={href} className={cn(LINK, 'underline break-words')}>
      {text}
    </Link>
  ) : (
    <span className="break-words">{text}</span>
  )
}

function Reason({ row, canRedact }: { row: AuditEntry; canRedact: boolean }) {
  if (row.redactedAt) {
    return (
      <span className="text-muted-foreground">Redacted on {formatWatDate(row.redactedAt)}</span>
    )
  }
  if (!row.reason) return <>—</>
  return (
    <span className="flex flex-col items-end gap-1 sm:items-start">
      <span className="break-words">{row.reason}</span>
      {canRedact ? <RedactReason auditId={row.id} /> : null}
    </span>
  )
}

function Result({ row }: { row: AuditEntry }) {
  return (
    <span className="flex flex-col items-end gap-1 sm:items-start">
      <AdminStatusPill value={row.outcome} labels={AUDIT_OUTCOME_LABEL} />
      {row.errorCode ? (
        <code className="font-mono text-xs break-words">{row.errorCode}</code>
      ) : null}
      {row.outcome === 'intent' ? (
        <span data-gateway-result className="text-xs text-muted-foreground">
          {gatewayResult(row.result)}
        </span>
      ) : null}
      {row.parentId !== null ? (
        <Link href={adminHref.audit(row.parentId)} className={cn(LINK, 'text-xs underline')}>
          For entry #{row.parentId}
        </Link>
      ) : null}
    </span>
  )
}

/** Everything else the entry holds, and its `detail` — made safe on the server. */
function Details({ row }: { row: AuditEntry }) {
  const facts: { label: string; value: React.ReactNode }[] = [
    {
      label: 'Sign-in',
      value: row.session ? <code className="font-mono">{row.session}</code> : '—',
    },
    {
      label: 'Target',
      value: (
        <>
          {targetLabel(row.targetType)}
          {row.targetId ? (
            <>
              {' '}
              <code className="font-mono break-all">{row.targetId}</code>
            </>
          ) : null}
        </>
      ),
    },
    {
      label: 'A test record',
      value: row.targetTestMode === null ? '—' : row.targetTestMode ? 'yes' : 'no',
    },
    {
      label: 'Request id',
      value: row.requestId ? (
        <code className="font-mono break-all select-all">{row.requestId}</code>
      ) : (
        '—'
      ),
    },
  ]
  if (row.errorCode) facts.push({ label: 'Why', value: adminErrorWords(row.errorCode) })
  if (row.outcome === 'intent' && row.result) {
    facts.push({
      label: 'Gateway result',
      value: (
        <Link href={adminHref.audit(row.result.id)} className={cn(LINK, 'underline')}>
          Entry #{row.result.id}, {formatWat(row.result.createdAt)}
        </Link>
      ),
    })
  }
  return (
    <details className="group min-w-0 text-left xl:w-56" data-entry-details={row.id}>
      <summary
        className={cn(
          'inline-flex min-h-11 cursor-pointer items-center rounded text-sm underline underline-offset-4 hover:no-underline active:opacity-80',
          FOCUS,
        )}
      >
        <span className="group-open:hidden">Show</span>
        <span className="hidden group-open:inline">Hide</span>
        <span className="sr-only"> details of entry #{row.id}</span>
      </summary>
      <div className="mt-2 space-y-3 text-sm">
        <dl className="grid grid-cols-1 gap-y-1.5">
          {facts.map((fact) => (
            <div key={fact.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{fact.label}</dt>
              <dd className="break-words text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <div>
          <p className="text-xs font-medium text-muted-foreground">What was recorded</p>
          {row.detail.length === 0 ? (
            <p className="mt-1 text-muted-foreground">{NO_DETAIL}</p>
          ) : (
            <dl className="mt-1 grid grid-cols-1 gap-y-1">
              {row.detail.map((line) => (
                <div
                  // A path names one place in the detail, so each is its own key.
                  key={line.label}
                  className="min-w-0"
                  data-detail-line={line.label}
                >
                  <dt>
                    <code className="font-mono text-xs break-all text-muted-foreground">
                      {line.label}
                    </code>
                  </dt>
                  <dd
                    className={cn(
                      'break-words',
                      line.hidden ? 'text-muted-foreground italic' : 'text-foreground',
                    )}
                  >
                    {line.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </details>
  )
}

function columns(params: AuditParams, canRedact: boolean): Column<AuditEntry, AuditSort>[] {
  return [
    {
      key: 'when',
      header: 'When',
      sort: 'when',
      // The row header sits at the top, with every other cell (DataTable's cells are top-aligned).
      className: 'align-top',
      cell: (row) => <When row={row} />,
    },
    { key: 'admin', header: 'Admin', cell: (row) => <Admin row={row} params={params} /> },
    { key: 'action', header: 'Action', cell: (row) => <Action row={row} /> },
    { key: 'target', header: 'Target', cell: (row) => <Target row={row} /> },
    {
      key: 'side',
      header: 'Side',
      cell: (row) => (row.side ? labelFor(SIDE_LABEL, row.side) : '—'),
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (row) => <Reason row={row} canRedact={canRedact} />,
    },
    { key: 'result', header: 'Result', cell: (row) => <Result row={row} /> },
    {
      key: 'request',
      header: 'Request id',
      cell: (row) =>
        row.requestId ? <code className="font-mono text-xs">{shortId(row.requestId)}</code> : '—',
    },
    { key: 'details', header: 'Details', cell: (row) => <Details row={row} /> },
  ]
}

function NoEntries({ params, testOnly }: { params: AuditParams; testOnly: boolean }) {
  if (params.id !== null) {
    return (
      <EmptyState
        title={`No entry #${params.id} to show.`}
        body={
          testOnly
            ? `There is no such entry, or it is not a test administrator's. ${AUDIT_TEST_ADMIN_NOTE}`
            : 'There is no entry with that number.'
        }
        action={
          <Link href={auditHref(params, { id: null })} className={cn(LINK, 'underline')}>
            Show every entry
          </Link>
        }
      />
    )
  }
  if (auditFiltersActive(params)) {
    return (
      <EmptyState
        title="No entries match these filters."
        action={
          <Link href={AUDIT_PATH} className={cn(LINK, 'underline')}>
            Clear the filters
          </Link>
        }
      />
    )
  }
  return (
    <EmptyState
      title="Nothing has been recorded yet."
      body="Every admin action, refusal, customer lookup and live read is recorded here as it happens."
    />
  )
}

export function AuditList({
  rows,
  total,
  params,
  testOnly,
  canRedact = false,
}: {
  rows: AuditEntry[]
  total: number
  params: AuditParams
  testOnly: boolean
  /** The owner: each typed reason offers "Redact reason" (§5.2 B14). */
  canRedact?: boolean
}) {
  const dir = params.list.dir
  return (
    <>
      <DataTable
        caption={`Audit entries, ${dir === 'asc' ? 'oldest' : 'newest'} first`}
        rows={rows}
        columns={columns(params, canRedact)}
        rowKey={(row) => String(row.id)}
        sorting={{
          sort: 'when',
          dir,
          href: () => auditHref(params, { dir: dir === 'asc' ? 'desc' : 'asc' }),
        }}
        empty={<NoEntries params={params} testOnly={testOnly} />}
      />
      <Pager
        page={params.list.page}
        pageCount={pageCount(total, params.list.per)}
        total={total}
        href={(page) => auditHref(params, { page })}
      />
    </>
  )
}
