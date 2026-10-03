import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { FOCUS, PANEL_HEADING, Panel } from '@/components/layout/panel'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { formatCount } from '@/features/admin/lib/format'
import {
  itemLabel,
  LOST_LABEL,
  MARGIN_COLUMNS,
  MARGIN_SCOPE,
  marginCaption,
  NOT_KNOWN,
  SOURCE_LABEL,
  sideName,
  sideWord,
  TOPUP_NOTE,
  TOTAL_LABEL,
} from '@/features/admin/lib/money-copy'
import { marginCsv, moneyCsvName } from '@/features/admin/lib/money-csv'
import {
  type MarginGroup,
  type MarginLine,
  type MarginSummary,
  marginSummary,
} from '@/features/admin/lib/money-data'
import {
  formatSpan,
  LEDGER_HREF,
  type MoneyParams,
  ordersHref,
} from '@/features/admin/lib/money-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { getMargin } from '@/features/admin/queries/money'
import { cn } from '@/lib/utils'
import { CsvDownload } from './csv-download'

export const MARGIN_HEADING = 'Margin'

const TEXT_LINK = cn(
  'inline-flex min-h-11 items-center rounded text-foreground underline underline-offset-4 hover:no-underline active:opacity-80',
  FOCUS,
)

/** A row of the table: a sold group, the lost row, or the total. */
type MarginRow = MarginLine & { label: string; kind: 'sold' | 'lost' | 'total' }

/**
 * Gross margin at the rate charged (docs/ADMIN-SPEC.md §5.2 B7, §6, D13),
 * from `admin_margin`: only from a real cost — a matched ledger debit, else
 * the cost recorded at checkout. A line with neither is counted, keeps its
 * revenue on its own row, and is left out of the margin; nothing is
 * estimated. The supplier's charges on failed or refunded lines are a row of
 * their own, always shown.
 */
export async function MarginSection({ side, params }: { side: AdminSide; params: MoneyParams }) {
  const groups = await getMargin(side, params)
  return <MarginReport groups={groups} side={side} params={params} />
}

export function MarginReport({
  groups,
  side,
  params,
}: {
  groups: MarginGroup[] | null
  side: AdminSide
  params: MoneyParams
}) {
  const summary = groups ? marginSummary(groups) : null
  return (
    <Panel labelledBy="money-margin-heading" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="money-margin-heading" className={PANEL_HEADING}>
            {MARGIN_HEADING}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {sideWord(side)} side · {formatSpan(params.from, params.to)} · in naira, VAT excluded
          </p>
        </div>
        {summary && !summary.empty ? (
          <CsvDownload
            fileName={moneyCsvName('margin', params, side)}
            csv={marginCsv(summary, params, side)}
            about={`margin, ${sideName(side)}`}
          />
        ) : null}
      </div>
      <div className="mt-4">
        {summary === null ? (
          <ErrorState
            title="Margin couldn't be loaded."
            body="Nothing was changed. Try again; sales above are read on their own."
          />
        ) : summary.empty ? (
          <EmptyState
            title={`No paid lines on ${sideName(side)} in these dates.`}
            body="Margin counts a line in the dates it was paid. Choose wider dates, or switch sides."
          />
        ) : (
          <MarginBody summary={summary} side={side} params={params} />
        )}
      </div>
    </Panel>
  )
}

function MarginBody({
  summary,
  side,
  params,
}: {
  summary: MarginSummary
  side: AdminSide
  params: MoneyParams
}) {
  const rows: MarginRow[] = [
    ...summary.sold.map((line) => ({
      ...line,
      label: itemLabel(line.itemType ?? ''),
      kind: 'sold' as const,
    })),
    { ...summary.lost, label: LOST_LABEL, kind: 'lost' },
    {
      ...summary.total,
      key: 'total',
      itemType: null,
      source: 'ledger',
      label: TOTAL_LABEL,
      kind: 'total',
    },
  ]
  return (
    <div className="space-y-4">
      <p data-margin-caption className="text-sm text-foreground">
        {marginCaption(summary.uncostedLines)}
      </p>
      <DataTable
        caption={`Margin by what was sold and where its cost came from, ${sideName(side)}, in naira`}
        rows={rows}
        columns={marginColumns(summary.hasTopupCost, params)}
        rowKey={(row) => row.key}
        empty={null}
      />
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{MARGIN_SCOPE}</p>
        {summary.hasTopupCost ? <p>{TOPUP_NOTE}</p> : null}
      </div>
    </div>
  )
}

const money = (kobo: number | null) => (kobo === null ? NOT_KNOWN : formatNaira(kobo))

/**
 * Item, then §5.2's Lines · Costed · Revenue · Cost · Margin · Source, with the
 * cost at the last top-up rate only when some line has one (live, after a
 * top-up's cost is recorded). A sold item links to its orders over the same
 * dates and the lost row to the ledger that matched its charges, which also
 * gives the table's scroll box something to focus when it overflows.
 */
export function marginColumns(
  withTopup: boolean,
  range: Pick<MoneyParams, 'from' | 'to'>,
): Column<MarginRow>[] {
  const columns: Column<MarginRow>[] = [
    {
      key: 'item',
      header: 'Item',
      cell: (row) => {
        const href =
          row.kind === 'lost'
            ? LEDGER_HREF
            : row.kind === 'sold'
              ? ordersHref(range, row.itemType)
              : null
        return (
          <span data-margin-row={row.kind === 'sold' ? row.key : row.kind}>
            {href ? (
              <Link href={href} className={TEXT_LINK}>
                {row.label}
              </Link>
            ) : (
              row.label
            )}
          </span>
        )
      },
    },
    {
      key: 'lines',
      header: MARGIN_COLUMNS.lines,
      cell: (row) => formatCount(row.lines),
      numeric: true,
    },
    {
      key: 'costed',
      header: MARGIN_COLUMNS.costed,
      cell: (row) => formatCount(row.costedLines),
      numeric: true,
    },
    {
      key: 'revenue',
      header: MARGIN_COLUMNS.revenue,
      cell: (row) => money(row.revenueKobo),
      numeric: true,
    },
    {
      key: 'cost',
      header: MARGIN_COLUMNS.cost,
      cell: (row) => money(row.costKobo),
      numeric: true,
    },
    {
      key: 'margin',
      header: MARGIN_COLUMNS.margin,
      cell: (row) => (
        <span className={cn(row.kind === 'total' && 'font-semibold')}>{money(row.marginKobo)}</span>
      ),
      numeric: true,
    },
    {
      key: 'source',
      header: MARGIN_COLUMNS.source,
      cell: (row) => (row.kind === 'total' ? '—' : SOURCE_LABEL[row.source]),
    },
  ]
  if (withTopup) {
    columns.push({
      key: 'topup',
      header: MARGIN_COLUMNS.topup,
      cell: (row) => money(row.costTopupKobo),
      numeric: true,
    })
  }
  return columns
}
