import Link from 'next/link'
import { Suspense } from 'react'
import { FOCUS, PANEL_HEADING, Panel, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { canAct } from '@/features/admin/lib/actions'
import { formatUsd, formatWat } from '@/features/admin/lib/format'
import { LEDGER_STATE_LABEL } from '@/features/admin/lib/labels'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { notOfferedWords } from '@/features/admin/lib/supplier-copy'
import {
  checkChain,
  formatDelta,
  isFiltered,
  kindLabel,
  LEDGER_STATES,
  type LedgerSearch,
  type LedgerSort,
  ledgerHref,
  matchLabel,
  parseLedgerSearch,
  revisionLines,
  stripWords,
} from '@/features/admin/lib/supplier-ledger'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import {
  getLedgerChain,
  getLedgerPage,
  getLedgerRevisions,
  getSupplierFloat,
  type LedgerRevision,
  type LedgerRow,
} from '@/features/admin/queries/supplier'
import { cn } from '@/lib/utils'
import { LiveLedgerSearch } from './live-ledger-search'
import { SupplierHeader } from './supplier-header'

export type LedgerPageSearch = Record<string, string | string[] | undefined>

/**
 * `/admin/supplier/ledger` (docs/ADMIN-SPEC.md §5.2 B6, §7): our mirror of
 * DomainNameAPI's statement, each entry matched or explained, with the
 * supplier's revisions in `<details>`; filters in the URL (`?status=` —
 * `?status=unexplained` from the overview — `?trace=` from an alert); the
 * balance chain; and a search of the live ledger, sent as a POST.
 */
export async function LedgerView({ searchParams }: { searchParams: Promise<LedgerPageSearch> }) {
  const admin = await requireAdmin()
  const [side, search] = await Promise.all([getAdminSide(admin), searchParams])
  const params = parseLedgerSearch(search)
  const liveWords = notOfferedWords(admin, 'supplier.ledger_live')
  return (
    <PanelPage>
      <SupplierHeader
        title="Supplier ledger"
        description="Our mirror of DomainNameAPI's statement, read every hour: each entry matched to what spent it, or explained."
        side={side}
        testOnly={admin.testOnly}
      />
      <Suspense fallback={<ChainSkeleton />}>
        <ChainStrip admin={admin} side={side} />
      </Suspense>
      <Suspense fallback={<TableSkeleton rows={8} />}>
        <LedgerList admin={admin} side={side} params={params} />
      </Suspense>
      <Panel labelledBy="supplier-live-ledger-heading">
        <h2 id="supplier-live-ledger-heading" className={PANEL_HEADING}>
          Search the live ledger
        </h2>
        <div className="mt-3">
          {canAct(admin, 'supplier.ledger_live') ? (
            <LiveLedgerSearch />
          ) : (
            <p className="text-sm text-muted-foreground">{liveWords}</p>
          )}
        </div>
      </Panel>
    </PanelPage>
  )
}

/** The balance chain (§7.5): every entry starts where the one before it ended. */
export async function ChainStrip({ admin, side }: { admin: AdminPrincipal; side: AdminSide }) {
  const [entries, float] = await Promise.all([getLedgerChain(admin, side), getSupplierFloat(side)])
  if (!entries) {
    return <ErrorState title="The balance chain couldn't be checked." />
  }
  const chain = checkChain(entries, side)
  const read = float?.ledgerReadAt
    ? `Last read from DomainNameAPI ${formatWat(float.ledgerReadAt)}.`
    : ''
  return (
    <Panel labelledBy="supplier-chain-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="supplier-chain-heading" className={PANEL_HEADING}>
          Balance chain
        </h2>
        {chain.count === 0 ? null : (
          <AdminStatusPill
            value={chain.breaks.length === 0 ? 'ok' : 'warning'}
            labels={{
              ok: 'Agrees',
              warning: `${chain.breaks.length} ${chain.breaks.length === 1 ? 'break' : 'breaks'}`,
            }}
          />
        )}
      </div>
      {chain.count === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No ledger entries on this side yet. {read}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            {chain.breaks.length === 0
              ? `The latest ${chain.count} ${chain.count === 1 ? 'entry agrees' : 'entries agree'}: each starts where the one before it ended.`
              : 'An entry does not start where the one before it ended: the supplier changed or left out an entry, or a read missed one.'}{' '}
            {read}
          </p>
          <p className="relative mt-3 overflow-x-auto rounded-xl bg-background/70 px-3.5 py-3 font-mono text-sm text-foreground tabular-nums">
            <span className="sr-only">Balances in US dollars, oldest first: </span>
            {stripWords(chain.strip)}
          </p>
          {chain.breaks.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {chain.breaks.slice(0, 5).map((gap) => (
                <li key={gap.traceId}>
                  {formatWat(gap.occurredAt)}: starts at {formatUsd(gap.foundCents)}, not{' '}
                  {formatUsd(gap.expectedCents)}.{' '}
                  <Link
                    href={`/admin/supplier/ledger?trace=${gap.traceId}`}
                    className={cn('font-medium underline underline-offset-2', FOCUS)}
                  >
                    Open this entry
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Panel>
  )
}

function ChainSkeleton() {
  return <div aria-hidden="true" className="h-36 animate-pulse rounded-3xl bg-muted/60" />
}

export async function LedgerList({
  admin,
  side,
  params,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: LedgerSearch
}) {
  const page = await getLedgerPage(admin, side, params)
  const revisions = page
    ? await getLedgerRevisions(
        admin,
        side,
        page.rows.map((row) => row.traceId),
      )
    : null
  if (!page || !revisions) {
    return <ErrorState title="The ledger couldn't be loaded." />
  }

  const columns: Column<LedgerRow, LedgerSort>[] = [
    {
      key: 'when',
      header: 'When',
      sort: 'occurred',
      cell: (row) => <span className="whitespace-nowrap">{formatWat(row.occurredAt)}</span>,
    },
    {
      key: 'description',
      header: 'Description',
      cell: (row) => <span className="break-all">{row.description || '—'}</span>,
    },
    { key: 'kind', header: 'Kind', cell: (row) => kindLabel(row) },
    {
      key: 'change',
      header: 'Change',
      sort: 'change',
      numeric: true,
      cell: (row) => formatDelta(row.deltaCents),
    },
    {
      key: 'balance',
      header: 'Balance after',
      numeric: true,
      cell: (row) => formatUsd(row.balanceCents),
    },
    {
      key: 'match',
      header: 'Match',
      cell: (row) => <MatchCell row={row} />,
    },
    {
      key: 'revisions',
      header: 'Revisions',
      cell: (row) => <Revisions list={revisions.get(row.traceId) ?? []} />,
    },
    {
      key: 'trace',
      header: 'Trace id',
      cell: (row) => <code className="font-mono text-xs break-all">{row.traceId}</code>,
    },
  ]

  const chips = LEDGER_STATES.map((state) => ({
    value: state,
    label: LEDGER_STATE_LABEL[state] ?? state,
  }))
  const toggle = (value: string) => {
    const state = value as (typeof LEDGER_STATES)[number]
    return ledgerHref(params, {
      status: params.status.includes(state)
        ? params.status.filter((s) => s !== state)
        : [...params.status, state],
    })
  }

  return (
    <Panel labelledBy="supplier-ledger-heading">
      <h2 id="supplier-ledger-heading" className={PANEL_HEADING}>
        Entries
      </h2>
      <div className="mt-3 space-y-3">
        <FilterChips
          label="Match"
          chips={chips}
          selected={params.status}
          href={toggle}
          allHref={ledgerHref(params, { status: [] })}
        />
        <DateFilter params={params} />
        {params.trace ? (
          <p className="text-sm text-muted-foreground">
            Showing one entry, <code className="font-mono break-all">{params.trace}</code>.{' '}
            <Link
              href={ledgerHref(params, { trace: null })}
              className={cn('font-medium text-foreground underline underline-offset-2', FOCUS)}
            >
              Show every entry
            </Link>
          </p>
        ) : null}
      </div>
      <DataTable
        caption="Supplier ledger entries"
        rows={page.rows}
        rowKey={(row) => row.traceId}
        columns={columns}
        className="mt-4"
        sorting={{
          sort: params.sort,
          dir: params.dir,
          href: (sort) => ledgerHref(params, nextSort(params, sort)),
        }}
        empty={
          isFiltered(params) ? (
            <EmptyState
              className="mt-4"
              title="No entries match these filters."
              action={
                <Link
                  href="/admin/supplier/ledger"
                  className={cn(
                    'inline-flex h-11 items-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted active:scale-[0.98]',
                    FOCUS,
                  )}
                >
                  Clear the filters
                </Link>
              }
            />
          ) : (
            <EmptyState
              className="mt-4"
              title="No ledger entries on this side yet."
              body="The gateway reads DomainNameAPI's statement every hour; entries appear after its first read."
            />
          )
        }
      />
      {page.rows.length > 0 ? (
        <div className="mt-4">
          <Pager
            page={params.page}
            pageCount={pageCount(page.total, params.per)}
            total={page.total}
            href={(n) => ledgerHref(params, { page: n })}
          />
        </div>
      ) : null}
    </Panel>
  )
}

function MatchCell({ row }: { row: LedgerRow }) {
  return (
    <div className="space-y-1">
      <AdminStatusPill value={row.matchState} labels={LEDGER_STATE_LABEL} />
      <p className="text-xs text-muted-foreground">{matchLabel(row)}</p>
      {row.matchState === 'matched' && row.matchOrderItemId ? (
        <Link
          href={`/admin/orders?line=${row.matchOrderItemId}`}
          className={cn(
            'inline-flex min-h-11 items-center text-xs font-medium underline underline-offset-2',
            FOCUS,
          )}
        >
          Open the order line
        </Link>
      ) : null}
      {row.matchState === 'matched' && row.matchCallId ? (
        <p className="text-xs text-muted-foreground">Call #{row.matchCallId}</p>
      ) : null}
    </div>
  )
}

function Revisions({ list }: { list: LedgerRevision[] }) {
  if (list.length === 0) return <>None</>
  return (
    <details className="min-w-0">
      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {list.length} {list.length === 1 ? 'revision' : 'revisions'}
      </summary>
      <ol className="mt-2 space-y-2 text-xs text-muted-foreground">
        {list.map((revision) => (
          <li key={revision.id}>
            <span className="text-foreground">{formatWat(revision.seenAt)}</span> —{' '}
            {revision.applied ? 'status updated' : 'kept as read, not applied'}
            <ul className="mt-1 list-disc pl-4">
              {revisionLines(revision.changes).map((line) => (
                <li key={line} className="break-all">
                  {line}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  )
}

function DateFilter({ params }: { params: LedgerSearch }) {
  return (
    <form
      action="/admin/supplier/ledger"
      method="get"
      className="flex flex-wrap items-end gap-3"
      aria-label="Dates"
    >
      {params.status.length > 0 ? (
        <input type="hidden" name="status" value={params.status.join(',')} />
      ) : null}
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        From
        <input
          type="date"
          name="from"
          defaultValue={params.from ?? ''}
          className="h-11 rounded-xl border border-input bg-background px-3 text-base text-foreground sm:text-sm"
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        To
        <input
          type="date"
          name="to"
          defaultValue={params.to ?? ''}
          className="h-11 rounded-xl border border-input bg-background px-3 text-base text-foreground sm:text-sm"
        />
      </label>
      <button
        type="submit"
        className={cn(
          'inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98]',
          FOCUS,
        )}
      >
        Show these dates
      </button>
    </form>
  )
}
