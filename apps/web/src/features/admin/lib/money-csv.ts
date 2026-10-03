import { csvCell } from '@/features/domains/lib/csv'
import { itemLabel, LOST_LABEL, SOURCE_LABEL, sideWord, TOTAL_LABEL } from './money-copy'
import type { MarginLine, MarginSummary, RevenueBucket } from './money-data'
import { bucketSpan, type Grain, type MoneyParams } from './money-params'
import type { AdminSide } from './side'

/**
 * The Money page as CSV files (docs/ADMIN-SPEC.md §5.2 B7): aggregates only —
 * no customer, order or domain is in them (D20 keeps personal data out of
 * CSV) — built in the browser from what the page already shows.
 *
 * The formula guard is the portfolio's (`csvCell`, CLAUDE.md §15 "CSV export
 * guards against formulas"): a text cell starting with = + - @, a tab or a
 * carriage return gets a leading apostrophe, so a spreadsheet shows it as
 * text and never runs it. A figure is not text: it is written from integer
 * kobo as a plain number (`-1234.50`), which a spreadsheet reads as a number
 * and cannot run, so a negative margin still adds up. Anything that is not a
 * plain number is guarded like text.
 */

/** A number for a spreadsheet, as opposed to text. */
export type Figure = { figure: string }

export type Cell = string | Figure | null

const PLAIN_NUMBER = /^-?\d+(\.\d{1,2})?$/

/** Naira with two decimals, from integer kobo by integer arithmetic — never a float (N5). */
export function naira(kobo: number): Figure {
  if (!Number.isSafeInteger(kobo)) throw new Error('naira() takes whole kobo')
  const sign = kobo < 0 ? '-' : ''
  const whole = Math.abs(kobo)
  return { figure: `${sign}${Math.trunc(whole / 100)}.${String(whole % 100).padStart(2, '0')}` }
}

/** A whole count. */
export function whole(count: number): Figure {
  if (!Number.isSafeInteger(count)) throw new Error('whole() takes a whole number')
  return { figure: String(count) }
}

/** One cell: a plain number as itself; text, and anything posing as a number, through the guard. */
export function moneyCell(cell: Cell): string {
  if (cell === null) return ''
  if (typeof cell === 'string') return csvCell(cell)
  return PLAIN_NUMBER.test(cell.figure) ? cell.figure : csvCell(cell.figure)
}

/** Records joined by CRLF, as RFC 4180 has it. The BOM is added when the file is saved. */
export function toMoneyCsv(rows: readonly (readonly Cell[])[]): string {
  return `${rows.map((row) => row.map(moneyCell).join(',')).join('\r\n')}\r\n`
}

export const REVENUE_CSV_HEADER = [
  'Side',
  'Period start',
  'Period end',
  'Orders paid',
  'Net sales excluding VAT (NGN)',
  'VAT collected (NGN)',
  'Cash in including VAT (NGN)',
  'Line refunds excluding VAT (NGN)',
  'VAT returned with line refunds (NGN)',
  'Charge refunds with no VAT (NGN)',
  'Flutterwave fees (NGN)',
  'Fees we absorbed (NGN)',
] as const

/** Every bucket SQL answered, empty ones too, so a spreadsheet's series has no gaps. */
export function revenueCsv(
  rows: readonly RevenueBucket[],
  params: Pick<MoneyParams, 'from' | 'to' | 'grain'>,
  side: AdminSide,
): string {
  return toMoneyCsv([
    REVENUE_CSV_HEADER,
    ...rows.map((row) => {
      const span = bucketSpan(row.bucket, params.grain, params)
      return [
        sideWord(side),
        span.start,
        span.end,
        whole(row.orders),
        naira(row.netKobo),
        naira(row.vatKobo),
        naira(row.cashKobo),
        naira(row.lineRefundKobo),
        naira(row.lineRefundVatKobo),
        naira(row.chargeRefundKobo),
        naira(row.feeKobo),
        naira(row.feeAbsorbedKobo),
      ]
    }),
  ])
}

export const MARGIN_CSV_HEADER = [
  'Side',
  'From',
  'To',
  'Item',
  'Lines',
  'Costed lines',
  'Revenue excluding VAT (NGN)',
  'Cost at the rate charged (NGN)',
  'Margin (NGN)',
  'Cost source',
  'Cost at the last top-up rate (NGN)',
] as const

const amount = (kobo: number | null): Cell => (kobo === null ? null : naira(kobo))

/** The margin table as shown: each sold group, the lost row, then the total over known costs. */
export function marginCsv(
  summary: MarginSummary,
  params: Pick<MoneyParams, 'from' | 'to'>,
  side: AdminSide,
): string {
  const row = (
    label: string,
    source: string,
    line: Omit<MarginLine, 'key' | 'itemType' | 'source'>,
  ) => [
    sideWord(side),
    params.from,
    params.to,
    label,
    whole(line.lines),
    whole(line.costedLines),
    naira(line.revenueKobo),
    amount(line.costKobo),
    amount(line.marginKobo),
    source,
    amount(line.costTopupKobo),
  ]
  return toMoneyCsv([
    MARGIN_CSV_HEADER,
    ...summary.sold.map((line) =>
      row(itemLabel(line.itemType ?? ''), SOURCE_LABEL[line.source], line),
    ),
    row(LOST_LABEL, SOURCE_LABEL.ledger, summary.lost),
    row(TOTAL_LABEL, '', summary.total),
  ])
}

/** `money-sales-test-2026-09-03-to-2026-10-03-by-day.csv`. */
export function moneyCsvName(
  kind: 'sales' | 'margin',
  params: Pick<MoneyParams, 'from' | 'to'> & { grain?: Grain },
  side: AdminSide,
): string {
  const by = kind === 'sales' && params.grain ? `-by-${params.grain}` : ''
  return `money-${kind}-${side}-${params.from}-to-${params.to}${by}.csv`
}
