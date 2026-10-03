import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { FOCUS, PANEL_HEADING, Panel } from '@/components/layout/panel'
import { BarChart } from '@/features/admin/components/charts/bar-chart'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { StatTile } from '@/features/admin/components/stat-tile'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { formatCount } from '@/features/admin/lib/format'
import {
  FEES_NOTE,
  REVENUE_COLUMNS,
  revenueNote,
  sideName,
  sideWord,
} from '@/features/admin/lib/money-copy'
import { moneyCsvName, revenueCsv } from '@/features/admin/lib/money-csv'
import {
  hasActivity,
  type RevenueBucket,
  type RevenueFigures,
  revenueTotals,
} from '@/features/admin/lib/money-data'
import {
  bucketLabel,
  bucketSpan,
  byGrain,
  formatSpan,
  lastYearHref,
  type MoneyParams,
  ordersHref,
} from '@/features/admin/lib/money-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { getRevenue } from '@/features/admin/queries/money'
import { cn } from '@/lib/utils'
import { CsvDownload } from './csv-download'

export const REVENUE_HEADING = 'Sales, cash and refunds'

const INNER_TILE = 'h-full rounded-2xl bg-background/70 shadow-none dark:bg-background/40'

const TEXT_LINK = cn(
  'inline-flex min-h-11 items-center rounded text-sm text-foreground underline underline-offset-4 hover:no-underline active:opacity-80',
  FOCUS,
)

/**
 * Sales, VAT, cash, refunds and fees over the dates chosen
 * (docs/ADMIN-SPEC.md §5.2 B7, §6), from `admin_revenue`: totals, a bar
 * chart each for net sales and cash in, and the table by bucket. VAT is
 * never inside a sales figure; cash in is every payment received, VAT included.
 */
export async function RevenueSection({
  side,
  params,
  now,
}: {
  side: AdminSide
  params: MoneyParams
  now: Date
}) {
  const rows = await getRevenue(side, params)
  return <RevenueReport rows={rows} side={side} params={params} now={now} />
}

export function RevenueReport({
  rows,
  side,
  params,
  now,
}: {
  rows: RevenueBucket[] | null
  side: AdminSide
  params: MoneyParams
  now: Date
}) {
  const span = formatSpan(params.from, params.to)
  return (
    <Panel labelledBy="money-revenue-heading" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="money-revenue-heading" className={PANEL_HEADING}>
            {REVENUE_HEADING}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {sideWord(side)} side · {span} · in naira, VAT shown on its own
          </p>
        </div>
        {rows && hasActivity(revenueTotals(rows)) ? (
          <CsvDownload
            fileName={moneyCsvName('sales', params, side)}
            csv={revenueCsv(rows, params, side)}
            about={`sales, cash and refunds ${byGrain(params.grain)}, ${sideName(side)}`}
          />
        ) : null}
      </div>
      <div className="mt-4">
        {rows === null ? (
          <ErrorState
            title="Sales couldn't be loaded."
            body="Nothing was changed. Try again; if it keeps failing, the health page says what is down."
          />
        ) : (
          <RevenueBody rows={rows} side={side} params={params} now={now} />
        )}
      </div>
    </Panel>
  )
}

function RevenueBody({
  rows,
  side,
  params,
  now,
}: {
  rows: RevenueBucket[]
  side: AdminSide
  params: MoneyParams
  now: Date
}) {
  const totals = revenueTotals(rows)
  if (!hasActivity(totals)) {
    return (
      <EmptyState
        title={`No sales, payments or refunds on ${sideName(side)} in these dates.`}
        body="Choose wider dates, or switch sides."
        action={
          <Link href={lastYearHref(now)} className={TEXT_LINK}>
            Show the last 12 months
          </Link>
        }
      />
    )
  }
  const label = (bucket: string) => bucketLabel(bucket, params.grain, params)
  const by = byGrain(params.grain)
  const shown = rows.filter(hasActivity)

  return (
    <div className="space-y-6">
      <TotalTiles totals={totals} side={side} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BarChart
          title={`Net sales ${by}, VAT excluded, in naira, ${sideName(side)}`}
          data={rows.map((row) => ({
            key: row.bucket,
            label: label(row.bucket),
            value: row.netKobo,
          }))}
          format={formatNaira}
        />
        <BarChart
          title={`Cash in ${by}, VAT included, in naira, ${sideName(side)}`}
          data={rows.map((row) => ({
            key: row.bucket,
            label: label(row.bucket),
            value: row.cashKobo,
          }))}
          format={formatNaira}
        />
      </div>

      <DataTable
        caption={`Sales, cash and refunds ${by}, ${sideName(side)}, in naira`}
        rows={shown}
        columns={revenueColumns(params)}
        rowKey={(row) => row.bucket}
        empty={null}
      />
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{revenueNote(params.grain)}</p>
        <p>{FEES_NOTE}</p>
      </div>
    </div>
  )
}

const naira = (kobo: number) => formatNaira(kobo)

/** The orders list over the days a bucket covers inside the dates. */
function periodOrdersHref(bucket: string, params: Pick<MoneyParams, 'from' | 'to' | 'grain'>) {
  const span = bucketSpan(bucket, params.grain, params)
  return ordersHref({ from: span.start, to: span.end })
}

/**
 * The table's columns, each saying whether VAT is in it. A period links to
 * the orders list over its days (§9's link contract; that list goes by when
 * an order was placed), which also gives the table's scroll box something
 * to focus when it is wider than the screen.
 */
export function revenueColumns(
  params: Pick<MoneyParams, 'from' | 'to' | 'grain'>,
): Column<RevenueBucket>[] {
  const figure = (
    key: keyof RevenueFigures,
    header: string,
    format: (value: number) => string = naira,
  ): Column<RevenueBucket> => ({
    key,
    header,
    cell: (row) => format(row[key]),
    numeric: true,
  })
  return [
    {
      key: 'period',
      header: 'Period',
      cell: (row) => (
        <Link
          href={periodOrdersHref(row.bucket, params)}
          className={cn(TEXT_LINK, 'whitespace-nowrap')}
        >
          {bucketLabel(row.bucket, params.grain, params)}
        </Link>
      ),
    },
    figure('orders', REVENUE_COLUMNS.orders, formatCount),
    figure('netKobo', REVENUE_COLUMNS.net),
    figure('vatKobo', REVENUE_COLUMNS.vat),
    figure('cashKobo', REVENUE_COLUMNS.cash),
    figure('lineRefundKobo', REVENUE_COLUMNS.lineRefund),
    figure('lineRefundVatKobo', REVENUE_COLUMNS.lineRefundVat),
    figure('chargeRefundKobo', REVENUE_COLUMNS.chargeRefund),
    figure('feeKobo', REVENUE_COLUMNS.fee),
    figure('feeAbsorbedKobo', REVENUE_COLUMNS.feeAbsorbed),
  ]
}

/** The totals over the dates chosen, each with its VAT and its side in its words. */
export function TotalTiles({ totals, side }: { totals: RevenueFigures; side: AdminSide }) {
  const on = sideWord(side)
  const tiles = [
    {
      key: 'net',
      label: 'Net sales',
      value: naira(totals.netKobo),
      hint: `${on} · VAT excluded`,
    },
    {
      key: 'vat',
      label: 'VAT collected',
      value: naira(totals.vatKobo),
      hint: `${on} · on those sales`,
    },
    {
      key: 'cash',
      label: 'Cash in',
      value: naira(totals.cashKobo),
      hint: `${on} · VAT included, with any duplicate or overpayment`,
    },
    {
      key: 'orders',
      label: 'Orders paid',
      value: formatCount(totals.orders),
      hint: on,
    },
    {
      key: 'lineRefunds',
      label: 'Line refunds',
      value: naira(totals.lineRefundKobo),
      hint: `${on} · VAT excluded; ${naira(totals.lineRefundVatKobo)} VAT returned with them`,
    },
    {
      key: 'chargeRefunds',
      label: 'Charge refunds',
      value: naira(totals.chargeRefundKobo),
      hint: `${on} · no VAT; duplicates, over- and underpayments, empty orders — cash in only`,
    },
    {
      key: 'fees',
      label: 'Flutterwave fees',
      value: naira(totals.feeKobo),
      hint: `${on} · as Flutterwave reported them`,
    },
    {
      key: 'feesAbsorbed',
      label: 'Fees we absorbed',
      value: naira(totals.feeAbsorbedKobo),
      hint: `${on} · taken from what we received`,
    },
  ]
  return (
    <ul className="grid grid-cols-1 gap-3 min-[26rem]:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <li key={tile.key} data-total={tile.key} className="min-w-0">
          <StatTile label={tile.label} value={tile.value} hint={tile.hint} className={INNER_TILE} />
        </li>
      ))}
    </ul>
  )
}
