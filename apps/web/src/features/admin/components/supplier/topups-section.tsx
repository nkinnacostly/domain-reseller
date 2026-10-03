import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { canAct } from '@/features/admin/lib/actions'
import { formatUsd, formatWat, formatWatDate } from '@/features/admin/lib/format'
import type { AdminSide } from '@/features/admin/lib/side'
import { notOfferedWords, OWNER_ONLY, TOPUPS_LIVE_ONLY } from '@/features/admin/lib/supplier-copy'
import type { Topup } from '@/features/admin/lib/supplier-data'
import {
  correctionsOf,
  formatPaid,
  formatRate,
  type TopupHistoryRow,
} from '@/features/admin/lib/supplier-topups'
import type { AdminPrincipal } from '@/features/admin/queries/session'
import {
  getCostingRate,
  getSupplierFloat,
  getTopupHistory,
} from '@/features/admin/queries/supplier'
import { TopupAction } from './topup-action'

/**
 * Our top-ups (docs/ADMIN-SPEC.md §5.2 B6, §6 "Top-ups"): each ledger credit
 * shaped like a top-up, with what it cost in naira once the owner records it
 * — Date · USD · NGN paid · Effective ₦/$ · Reference · Recorded by ·
 * Corrected. Recording and correcting are the owner's, on the live side,
 * with the code from the authenticator app (money tier).
 */
export async function TopupsSection({ admin, side }: { admin: AdminPrincipal; side: AdminSide }) {
  const [float, history, costing] = await Promise.all([
    getSupplierFloat(side),
    side === 'live' ? getTopupHistory(admin, side) : Promise.resolve([] as TopupHistoryRow[]),
    getCostingRate(admin),
  ])
  if (!float || !history) {
    return <ErrorState title="Top-ups couldn't be loaded." />
  }

  const notOffered =
    side === 'test' ? TOPUPS_LIVE_ONLY : notOfferedWords(admin, 'topup.record', OWNER_ONLY.topups)
  const mayRecord = side === 'live' && canAct(admin, 'topup.record')
  const mayCorrect = side === 'live' && canAct(admin, 'topup.correct')

  const columns: Column<Topup>[] = [
    {
      key: 'date',
      header: 'Date',
      cell: (row) => <span className="whitespace-nowrap">{formatWat(row.occurredAt)}</span>,
    },
    { key: 'usd', header: 'USD', numeric: true, cell: (row) => formatUsd(row.usdCents) },
    { key: 'ngn', header: 'NGN paid', numeric: true, cell: (row) => formatPaid(row.ngnPaidKobo) },
    {
      key: 'rate',
      header: 'Effective ₦/$',
      numeric: true,
      cell: (row) => formatRate(row.rateKoboPerCent),
    },
    {
      key: 'reference',
      header: 'Reference',
      cell: (row) => (row.reference ? <span className="break-all">{row.reference}</span> : '—'),
    },
    { key: 'by', header: 'Recorded by', cell: (row) => row.recordedBy ?? '—' },
    {
      key: 'corrected',
      header: 'Corrected',
      cell: (row) => <Corrected row={row} history={history} />,
    },
  ]
  if (mayRecord || mayCorrect) {
    columns.push({
      key: 'action',
      header: 'Action',
      cell: (row) =>
        row.id ? (
          mayCorrect ? (
            <TopupAction
              mode="correct"
              traceId={row.traceId}
              topupId={row.id}
              usdCents={row.usdCents}
              occurredAt={row.occurredAt}
              costing={costing}
            />
          ) : (
            '—'
          )
        ) : mayRecord ? (
          <TopupAction
            mode="record"
            traceId={row.traceId}
            usdCents={row.usdCents}
            occurredAt={row.occurredAt}
            costing={costing}
          />
        ) : (
          '—'
        ),
    })
  }

  return (
    <Panel labelledBy="supplier-topups-heading">
      <h2 id="supplier-topups-heading" className={PANEL_HEADING}>
        Top-ups
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Ledger credits shaped like a top-up, newest first, with what each cost in naira. The
        effective rate is naira paid per dollar credited.
      </p>
      {notOffered ? (
        <p className="mt-3 max-w-2xl rounded-xl bg-muted/60 px-3.5 py-3 text-sm text-foreground">
          {notOffered}
        </p>
      ) : null}
      <DataTable
        caption="Top-ups, newest first"
        rows={float.topups}
        rowKey={(row) => row.traceId}
        columns={columns}
        className="mt-4"
        empty={
          <EmptyState
            className="mt-4"
            title="No top-ups on this side yet."
            body="A top-up appears here once the hourly ledger read finds its credit."
          />
        }
      />
    </Panel>
  )
}

function Corrected({ row, history }: { row: Topup; history: readonly TopupHistoryRow[] }) {
  if (!row.supersedesId) return <>—</>
  const earlier = correctionsOf(row, history)
  return (
    <details className="min-w-0">
      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded text-sm text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        Yes — {earlier.length} earlier {earlier.length === 1 ? 'record' : 'records'}
      </summary>
      <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
        {earlier.map((record) => (
          <li key={record.id}>
            <span className="text-foreground">{formatPaid(record.ngnPaidKobo)}</span> ·{' '}
            <span className="break-all">{record.reference}</span> · {record.recordedBy},{' '}
            {formatWatDate(record.recordedAt)} — corrected
          </li>
        ))}
      </ul>
    </details>
  )
}
