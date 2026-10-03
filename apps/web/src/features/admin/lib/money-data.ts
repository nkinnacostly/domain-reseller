import { z } from 'zod'

/**
 * What `admin_revenue` and `admin_margin` answer (docs/ADMIN-SPEC.md §3.2h,
 * §5.2 B7, §6), and the sums the page shows. Money is integer kobo (D24, N5):
 * a value that is not a whole number fails the read rather than reaching a
 * figure, because a wrong number is worse than none. Nothing here estimates
 * a cost SQL did not give (D13, N9b).
 */

const kobo = z.number().int()
const count = z.number().int().nonnegative()
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** One bucket of `admin_revenue` — a day, a Monday-started week or a month, in Lagos. */
const revenueRow = z.object({
  bucket: day,
  orders: count,
  net_kobo: kobo,
  vat_kobo: kobo,
  cash_kobo: kobo,
  line_refunded_kobo: kobo,
  line_refunded_vat_kobo: kobo,
  charge_refunded_kobo: kobo,
  fee_kobo: kobo,
  fee_absorbed_kobo: kobo,
})

export type RevenueFigures = {
  /** Orders paid in the bucket. */
  orders: number
  /** `orders.subtotal_kobo` of paid orders, by `paid_at`: VAT excluded. */
  netKobo: number
  /** `orders.vat_kobo`, same orders. */
  vatKobo: number
  /** `payments.amount_kobo` by payment time: VAT included, duplicates and overpayments too. */
  cashKobo: number
  /** Completed refunds of a line: the line's price, VAT excluded. */
  lineRefundKobo: number
  /** The VAT returned with those refunds. */
  lineRefundVatKobo: number
  /** Completed refunds of a charge (no line): cash only, no VAT. */
  chargeRefundKobo: number
  /** Flutterwave's fee on each payment, as it reported it. */
  feeKobo: number
  /** The part of those fees taken from what we received. */
  feeAbsorbedKobo: number
}

export type RevenueBucket = RevenueFigures & { bucket: string }

export function parseRevenue(data: unknown): { rows: RevenueBucket[] } | { issues: number } {
  const parsed = z.array(revenueRow).safeParse(data)
  if (!parsed.success) return { issues: parsed.error.issues.length }
  return {
    rows: parsed.data.map((row) => ({
      bucket: row.bucket,
      orders: row.orders,
      netKobo: row.net_kobo,
      vatKobo: row.vat_kobo,
      cashKobo: row.cash_kobo,
      lineRefundKobo: row.line_refunded_kobo,
      lineRefundVatKobo: row.line_refunded_vat_kobo,
      chargeRefundKobo: row.charge_refunded_kobo,
      feeKobo: row.fee_kobo,
      feeAbsorbedKobo: row.fee_absorbed_kobo,
    })),
  }
}

const FIGURES: readonly (keyof RevenueFigures)[] = [
  'orders',
  'netKobo',
  'vatKobo',
  'cashKobo',
  'lineRefundKobo',
  'lineRefundVatKobo',
  'chargeRefundKobo',
  'feeKobo',
  'feeAbsorbedKobo',
]

/** Every bucket added up: the totals over the dates chosen. */
export function revenueTotals(rows: readonly RevenueFigures[]): RevenueFigures {
  const totals = Object.fromEntries(FIGURES.map((key) => [key, 0])) as RevenueFigures
  for (const row of rows) for (const key of FIGURES) totals[key] += row[key]
  return totals
}

/** Whether a bucket (or the totals) holds anything at all. */
export function hasActivity(figures: RevenueFigures): boolean {
  return FIGURES.some((key) => figures[key] !== 0)
}

// ── Margin ──────────────────────────────────────────────────────────────────

export const COST_SOURCES = ['ledger', 'checkout', 'none'] as const
export type CostSource = (typeof COST_SOURCES)[number]

/** One group of `admin_margin`: a month, sold or lost, an item type and where its cost came from. */
const marginRow = z.object({
  month: day,
  row_kind: z.enum(['sold', 'lost']),
  item_type: z.string().min(1),
  lines: count,
  costed_lines: count,
  revenue_kobo: kobo,
  cost_kobo: kobo.nullable(),
  margin_kobo: kobo.nullable(),
  cost_topup_kobo: kobo.nullable(),
  cost_source: z.enum(COST_SOURCES),
})

export type MarginGroup = z.infer<typeof marginRow>

export function parseMargin(data: unknown): { rows: MarginGroup[] } | { issues: number } {
  const parsed = z.array(marginRow).safeParse(data)
  return parsed.success ? { rows: parsed.data } : { issues: parsed.error.issues.length }
}

export type MarginLine = {
  key: string
  /** The item type of a sold line; null for the lost row, which takes every type. */
  itemType: string | null
  source: CostSource
  lines: number
  costedLines: number
  /** Kept from the line, VAT excluded; nothing for a lost line. */
  revenueKobo: number
  /** At the rate the order was charged; null when no cost is known (D13). */
  costKobo: number | null
  marginKobo: number | null
  /** The same dollars at the latest top-up's rate; null when there is none (live only). */
  costTopupKobo: number | null
}

export type MarginSummary = {
  /** Sold lines by item type, then by where the cost came from. */
  sold: MarginLine[]
  /** The supplier's charges on lines that failed or were refunded — always a row, maybe zero. */
  lost: MarginLine
  /** Costed sold lines and the lost row together: what the known costs leave. */
  total: Omit<MarginLine, 'key' | 'itemType' | 'source'>
  /** Sold lines with no known cost, left out of the margin. */
  uncostedLines: number
  /** Any row carries a cost at the last top-up rate, so the column is worth showing. */
  hasTopupCost: boolean
  /** SQL answered no groups at all. */
  empty: boolean
}

const ITEM_ORDER = ['register', 'renew', 'transfer', 'ssl']
const order = (list: readonly string[], value: string) => {
  const index = list.indexOf(value)
  return index === -1 ? list.length : index
}

/** Adds a nullable figure: unknown stays unknown only until a known one arrives. */
const plus = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : a + b

/**
 * The margin table over the dates chosen: SQL's monthly groups summed by
 * item type and source, every lost group in one row, and a total over the
 * lines whose cost is known. An uncosted line adds its revenue to its own
 * row but nothing to the total, which is margin on known cost only (D13).
 */
export function marginSummary(rows: readonly MarginGroup[]): MarginSummary {
  const sold = new Map<string, MarginLine>()
  const lost: MarginLine = {
    key: 'lost',
    itemType: null,
    source: 'ledger',
    lines: 0,
    costedLines: 0,
    revenueKobo: 0,
    costKobo: 0,
    marginKobo: 0,
    costTopupKobo: null,
  }
  let hasTopupCost = false

  for (const row of rows) {
    if (row.cost_topup_kobo !== null) hasTopupCost = true
    if (row.row_kind === 'lost') {
      lost.lines += row.lines
      lost.costedLines += row.costed_lines
      lost.costKobo = plus(lost.costKobo, row.cost_kobo)
      lost.marginKobo = plus(lost.marginKobo, row.margin_kobo)
      lost.costTopupKobo = plus(lost.costTopupKobo, row.cost_topup_kobo)
      continue
    }
    const key = `${row.item_type}:${row.cost_source}`
    const line = sold.get(key) ?? {
      key,
      itemType: row.item_type,
      source: row.cost_source,
      lines: 0,
      costedLines: 0,
      revenueKobo: 0,
      costKobo: null,
      marginKobo: null,
      costTopupKobo: null,
    }
    line.lines += row.lines
    line.costedLines += row.costed_lines
    line.revenueKobo += row.revenue_kobo
    line.costKobo = plus(line.costKobo, row.cost_kobo)
    line.marginKobo = plus(line.marginKobo, row.margin_kobo)
    line.costTopupKobo = plus(line.costTopupKobo, row.cost_topup_kobo)
    sold.set(key, line)
  }

  const soldLines = [...sold.values()].sort(
    (a, b) =>
      order(ITEM_ORDER, a.itemType ?? '') - order(ITEM_ORDER, b.itemType ?? '') ||
      (a.itemType ?? '').localeCompare(b.itemType ?? '') ||
      order(COST_SOURCES, a.source) - order(COST_SOURCES, b.source),
  )

  const costed = [...soldLines.filter((line) => line.source !== 'none'), lost]
  const total = {
    lines: costed.reduce((sum, line) => sum + line.lines, 0),
    costedLines: costed.reduce((sum, line) => sum + line.costedLines, 0),
    revenueKobo: costed.reduce((sum, line) => sum + line.revenueKobo, 0),
    costKobo: costed.reduce((sum, line) => sum + (line.costKobo ?? 0), 0),
    marginKobo: costed.reduce((sum, line) => sum + (line.marginKobo ?? 0), 0),
    costTopupKobo: costed.reduce<number | null>((sum, line) => plus(sum, line.costTopupKobo), null),
  }
  const uncostedLines = soldLines.reduce((sum, line) => sum + line.lines - line.costedLines, 0)

  return { sold: soldLines, lost, total, uncostedLines, hasTopupCost, empty: rows.length === 0 }
}
