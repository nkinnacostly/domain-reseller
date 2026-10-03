import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Pager } from '@/features/admin/components/table/pager'
import { DRIFT_NOTE, driftKindLabel } from '@/features/admin/lib/alerts-copy'
import {
  type AlertsParams,
  alertsListHref,
  alertsSortHref,
  type DriftSort,
} from '@/features/admin/lib/alerts-params'
import { formatCount } from '@/features/admin/lib/format'
import { pageCount } from '@/features/admin/lib/list-params'
import { type DriftRow, listOpenDrift } from '@/features/admin/queries/alerts'
import type { AdminPrincipal, AdminSide } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { AlertsNote, AlertsSection, PastTheLastPage, SeenAt } from './alert-parts'

/**
 * Where the registry and our records disagree (ADMIN-SPEC §5.2, D14). Read
 * only: the next complete reconcile closes a row or opens it again, so
 * nothing here resolves one by hand. A domain we hold links to its page.
 */

type DriftParams = Extract<AlertsParams, { tab: 'drift' }>

function DomainCell({ row }: { row: DriftRow }) {
  if (!row.domainHref) return <span className="break-all">{row.domainName}</span>
  return (
    <Link
      href={row.domainHref}
      className={cn(
        'inline-flex min-h-11 items-center rounded break-all text-brand-ink underline underline-offset-4 hover:no-underline active:opacity-80',
        FOCUS,
      )}
    >
      {row.domainName}
    </Link>
  )
}

function driftColumns(now: Date): Column<DriftRow, DriftSort>[] {
  return [
    { key: 'domain', header: 'Domain', cell: (row) => <DomainCell row={row} /> },
    { key: 'kind', header: 'Kind', cell: (row) => driftKindLabel(row.kind) },
    { key: 'ours', header: 'Ours', cell: (row) => row.ours },
    { key: 'registry', header: 'Registry', cell: (row) => row.registry },
    {
      key: 'first',
      header: 'First seen',
      sort: 'first_seen',
      cell: (row) => <SeenAt at={row.firstSeenAt} now={now} />,
    },
    {
      key: 'last',
      header: 'Last seen',
      sort: 'last_seen',
      cell: (row) => <SeenAt at={row.lastSeenAt} now={now} />,
    },
    {
      key: 'run',
      header: 'Last check',
      cell: (row) =>
        row.lastRun ? (
          <span className="inline-flex flex-col items-end gap-1 sm:items-start">
            <SeenAt at={row.lastRun.at} now={now} />
            {row.lastRun.failed ? (
              <AdminStatusPill value="failed" labels={{ failed: 'That check failed' }} />
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ]
}

export async function DriftList({
  admin,
  side,
  params,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: DriftParams
  now: Date
}) {
  const result = await listOpenDrift(admin, side, params.list)
  return (
    <AlertsSection
      id="drift-heading"
      title="Registry drift"
      aside={
        result.ok ? (
          <p className="text-sm text-muted-foreground">{formatCount(result.data.total)} open</p>
        ) : null
      }
    >
      <AlertsNote testId="drift-note">{DRIFT_NOTE}</AlertsNote>
      {result.ok ? (
        <>
          <DataTable
            caption="Open registry drift"
            rows={result.data.rows}
            rowKey={(row) => String(row.id)}
            columns={driftColumns(now)}
            sorting={{
              sort: params.list.sort,
              dir: params.list.dir,
              href: (sort) => alertsSortHref(params, sort),
            }}
            empty={
              result.data.total > 0 ? (
                <PastTheLastPage firstPage={alertsListHref(params, { page: 1 })} />
              ) : (
                <EmptyState
                  title="No drift"
                  body="The last complete reconcile found the registry and our records in agreement on this side."
                />
              )
            }
          />
          {result.data.total > 0 ? (
            <Pager
              page={params.list.page}
              pageCount={pageCount(result.data.total, params.list.per)}
              total={result.data.total}
              href={(page) => alertsListHref(params, { page })}
            />
          ) : null}
        </>
      ) : (
        <ErrorState title="The registry drift couldn't be loaded." />
      )}
    </AlertsSection>
  )
}
