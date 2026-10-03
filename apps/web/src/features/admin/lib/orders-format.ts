import { formatNaira, formatRenewal, SSL_TERM } from '@dr/shared'
import { formatUsd } from '@/features/admin/lib/format'
import { ORDER_KIND_LABEL, ORDER_KINDS, type OrderKind } from '@/features/admin/lib/orders-params'

/**
 * How the orders pages put an order into words (docs/ADMIN-SPEC.md §5.2,
 * B2). Money is kobo or integer cents, formatted only here (N5, D24); a
 * price is never shown without its renewal price (N8); a cost is shown only
 * as recorded, never estimated (D13).
 */

const isKind = (value: string): value is OrderKind =>
  (ORDER_KINDS as readonly string[]).includes(value)

/** The kinds an order's lines buy, in a fixed order: "Registration, Certificate". */
export function orderKindsText(lines: readonly { item_type: string }[]): string {
  const kinds = new Set(lines.map((line) => line.item_type))
  if (kinds.size === 0) return 'No lines'
  const known = ORDER_KINDS.filter((kind) => kinds.has(kind)).map((kind) => ORDER_KIND_LABEL[kind])
  const other = [...kinds].filter((kind) => !isKind(kind)).map((kind) => kind.replace(/_/g, ' '))
  return [...known, ...other].join(', ')
}

/** "1 year", "2 years"; a certificate is a subscription. */
export function lineTermText(line: { item_type: string; period_years: number }): string {
  if (line.item_type === 'ssl') return SSL_TERM.short
  const years = line.period_years
  return `${years} ${years === 1 ? 'year' : 'years'}`
}

/**
 * The renewal beside a line's price (N8): its term at its whole price, or —
 * for a certificate, which never renews by itself — a new one at today's price.
 */
export function lineRenewalText(line: {
  item_type: string
  renewal_kobo: number
  renewal_years: number | null
}): string {
  if (line.item_type === 'ssl') {
    return `A new one is ${formatNaira(Number(line.renewal_kobo))} at today’s price`
  }
  return `Renews at ${formatRenewal(Number(line.renewal_kobo), line.renewal_years ?? 1)}`
}

export type LineCost = { supplier_cost_cents: number; icann_fee_cents: number }

/**
 * What the line cost us as checkout recorded it (`order_item_costs`, D13):
 * "$11.31 + $0.20 ICANN (recorded at checkout)", or "Not recorded".
 */
export function lineCostText(cost: LineCost | null | undefined): string {
  if (!cost) return 'Not recorded'
  const supplier = formatUsd(Number(cost.supplier_cost_cents))
  const icann = Number(cost.icann_fee_cents)
  return icann > 0
    ? `${supplier} + ${formatUsd(icann)} ICANN (recorded at checkout)`
    : `${supplier} (recorded at checkout)`
}

export const FLOAT_CHECK_LABEL: Record<string, string> = {
  covered: 'Covered',
  shortfall_test_mode: 'Short (test mode)',
}

/** Kobo, or the words for an amount Flutterwave did not report. */
export function nairaOrUnreported(kobo: number | null | undefined): string {
  return kobo === null || kobo === undefined ? 'Not reported' : formatNaira(Number(kobo))
}

/**
 * Who bore Flutterwave's fee: we absorbed it when the customer was charged
 * exactly the order's amount (`admin_payments_v.absorbed`, ADMIN-SPEC §6).
 */
export function absorbedText(absorbed: boolean | null | undefined): string {
  if (absorbed === null || absorbed === undefined) return 'Not reported'
  return absorbed ? 'We paid it' : 'The customer paid it'
}

/** "820 ms", "2.4 s". */
export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** A median wait in words: "45 s", "12 min", "3 h 5 min", "2 days 4 h". */
export function waitText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86_400) {
    const hours = Math.floor(s / 3600)
    const minutes = Math.round((s % 3600) / 60)
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`
  }
  const days = Math.floor(s / 86_400)
  const hours = Math.round((s % 86_400) / 3600)
  const dayWord = days === 1 ? 'day' : 'days'
  return hours > 0 ? `${days} ${dayWord} ${hours} h` : `${days} ${dayWord}`
}

/** An event type or code as words: `nameservers_requested` → "Nameservers requested". */
export function sentenceCase(value: string | null | undefined): string {
  if (!value) return '—'
  const words = value.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
