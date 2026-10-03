import type { CostSource } from './money-data'
import type { AdminSide } from './side'

/**
 * The Money page's words (docs/ADMIN-SPEC.md §5.2 B7, §6). Every figure says
 * whether VAT is in it and which side it is from; the margin says what its
 * cost rests on and what it leaves out, and claims nothing more (N9b, D13).
 */

/** "Live" or "Test" — the side every figure here is from. */
export function sideWord(side: AdminSide): string {
  return side === 'test' ? 'Test' : 'Live'
}

/** "the live side", "the test side". */
export function sideName(side: AdminSide): string {
  return side === 'test' ? 'the test side' : 'the live side'
}

export const ITEM_LABEL: Record<string, string> = {
  register: 'Registrations',
  renew: 'Renewals',
  transfer: 'Transfers in',
  ssl: 'SSL certificates',
}

export function itemLabel(itemType: string): string {
  return ITEM_LABEL[itemType] ?? itemType.replace(/_/g, ' ')
}

export const SOURCE_LABEL: Record<CostSource, string> = {
  ledger: "DomainNameAPI's ledger",
  checkout: 'Recorded at checkout',
  none: 'Not costed',
}

export const LOST_LABEL = 'Supplier cost on failed or refunded lines'
export const TOTAL_LABEL = 'Total, lines with a known cost'

/** Shown where a cost is not known: never a guess (D13). */
export const NOT_KNOWN = 'Not known'

/** The revenue table's columns: what each holds, VAT in or out. */
export const REVENUE_COLUMNS = {
  orders: 'Orders paid',
  net: 'Net sales (VAT excluded)',
  vat: 'VAT collected',
  cash: 'Cash in (VAT included)',
  lineRefund: 'Line refunds (VAT excluded)',
  lineRefundVat: 'VAT returned with them',
  chargeRefund: 'Charge refunds (no VAT)',
  fee: 'Flutterwave fees',
  feeAbsorbed: 'Fees we absorbed',
} as const

/** The margin table's columns. */
export const MARGIN_COLUMNS = {
  lines: 'Lines',
  costed: 'Costed',
  revenue: 'Revenue (VAT excluded)',
  cost: 'Cost (at the rate charged)',
  margin: 'Margin',
  source: 'Source',
  topup: 'Cost at the last top-up rate',
} as const

const lines = (count: number) =>
  `${count.toLocaleString('en-GB')} ${count === 1 ? 'line' : 'lines'}`

/**
 * §5.2's caption, word for word, with the count of lines left out. With
 * none left out, the second sentence has nothing to say and is dropped.
 */
export function marginCaption(uncostedLines: number): string {
  const first =
    "Margin is shown at the rate we charged, and only for lines whose cost is known — matched to DomainNameAPI's ledger, or recorded at checkout."
  if (uncostedLines <= 0) return first
  return `${first} ${lines(uncostedLines)} sold before costs were recorded ${uncostedLines === 1 ? 'is' : 'are'} left out.`
}

/** What the lost row and the dates mean (§6 "Gross margin"). */
export const MARGIN_SCOPE =
  "Lines count in the dates they were paid. A line that failed or was refunded counts only when DomainNameAPI's ledger shows it charged us for it."

/** The optional column: an estimate, said as one. */
export const TOPUP_NOTE =
  'Cost at the last top-up rate prices the same dollars at what the latest recorded float top-up cost us. It is an estimate of replacing them, not what was charged.'

/** How the revenue table is cut. */
export function revenueNote(grain: 'day' | 'week' | 'month'): string {
  const period = grain === 'day' ? 'days' : grain === 'week' ? 'weeks' : 'months'
  const cut =
    grain === 'week'
      ? ' Weeks start on Monday; a week or month cut by your dates counts only the days inside them.'
      : grain === 'month'
        ? ' A month cut by your dates counts only the days inside them.'
        : ''
  return `${period[0]?.toUpperCase()}${period.slice(1)} with no sales, payments or refunds are left out of the table; the charts and the CSV keep every one.${cut} Sales count when paid, cash when received, refunds when completed.`
}

/** Fees, as far as we know them. */
export const FEES_NOTE =
  'Flutterwave fees are as Flutterwave reported them on each payment. We absorbed a fee when the customer paid nothing on top of the order, so it came out of what we received.'
