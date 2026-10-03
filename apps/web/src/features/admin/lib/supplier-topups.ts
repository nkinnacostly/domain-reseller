import { formatNaira } from '@dr/shared'
import { formatUsd, formatWatDate } from './format'
import type { Topup } from './supplier-data'

/**
 * What a float top-up cost (docs/ADMIN-SPEC.md §3.2b, §5.2 B6, §6 "Top-ups"):
 * the naira paid for a ledger credit in dollars. Money stays integer kobo and
 * cents (N5); the effective rate is their quotient, kobo per cent — which is
 * naira per dollar — worked as SQL works it, `ngn_paid_kobo::numeric /
 * usd_cents` rounded to 4 places, never integer division and never a float.
 */

const RATE_PLACES = 4n
const RATE_SCALE = 10n ** RATE_PLACES

/**
 * Kobo per cent to 4 decimal places, half away from zero, as a decimal string
 * ("1620.5000"). Null when either side is not a positive whole number.
 */
export function rateKoboPerCent(ngnPaidKobo: number, usdCents: number): string | null {
  if (!Number.isSafeInteger(ngnPaidKobo) || !Number.isSafeInteger(usdCents)) return null
  if (ngnPaidKobo <= 0 || usdCents <= 0) return null
  const kobo = BigInt(ngnPaidKobo)
  const cents = BigInt(usdCents)
  // Scaled by 10⁴, rounded half up (both are positive).
  const scaled = (kobo * RATE_SCALE * 2n + cents) / (cents * 2n)
  const whole = scaled / RATE_SCALE
  const fraction = (scaled % RATE_SCALE).toString().padStart(Number(RATE_PLACES), '0')
  return `${whole}.${fraction}`
}

const RATE_FORMAT = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** "₦1,620.50/$" from a rate in kobo per cent (= naira per dollar). Display only. */
export function formatRate(rate: string | number | null | undefined): string {
  if (rate === null || rate === undefined || rate === '') return '—'
  const value = typeof rate === 'number' ? rate : Number(rate)
  if (!Number.isFinite(value) || value < 0) return '—'
  return `₦${RATE_FORMAT.format(value)}/$`
}

/**
 * How the effective rate sits against the costing rate the storefront prices
 * at: "12.3% above costing". Display only — no amount is derived from it.
 */
export function rateAgainstCosting(
  rate: string | number | null | undefined,
  costing: number | null | undefined,
): string | null {
  const value = typeof rate === 'string' ? Number(rate) : rate
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (costing === null || costing === undefined || !(costing > 0)) return null
  const pct = ((value - costing) / costing) * 100
  const rounded = Math.round(pct * 10) / 10
  if (rounded === 0) return 'the same as costing'
  return `${Math.abs(rounded).toFixed(1)}% ${rounded > 0 ? 'above' : 'below'} costing`
}

/** The largest top-up the form takes: ₦1,000,000,000 (a typo guard, not a business rule). */
export const MAX_NGN_PAID_KOBO = 100_000_000_000

/**
 * Naira typed by a person ("58,320", "58320.5", "₦58,320.50") to whole kobo,
 * read as decimal text — never through a float. Null for anything else, more
 * than two decimal places, nothing, or more than the guard.
 */
export function nairaToKobo(text: string): number | null {
  const cleaned = text.trim().replace(/^₦/, '').replace(/,/g, '').trim()
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!match) return null
  const kobo = BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')
  if (kobo <= 0n || kobo > BigInt(MAX_NGN_PAID_KOBO)) return null
  return Number(kobo)
}

/** "$36.00 on 1 Oct 2026": the ledger credit a top-up is. */
export function creditWords(topup: Pick<Topup, 'usdCents' | 'occurredAt'>): string {
  return `${formatUsd(topup.usdCents)} on ${formatWatDate(topup.occurredAt)}`
}

/** "Ledger credit $36.00 on 1 Oct 2026": what a top-up row is, in the dialog. */
export function creditLine(topup: Pick<Topup, 'usdCents' | 'occurredAt'>): string {
  return `Ledger credit ${creditWords(topup)}`
}

/** "₦1,620.50/$ against costing ₦1,328.10/$ (22.0% above costing)". */
export function rateWords(
  rate: string | number | null,
  costing: number | null | undefined,
): string {
  const effective = formatRate(rate)
  if (costing === null || costing === undefined || !(costing > 0)) {
    return `${effective}; no active costing rate to compare`
  }
  const against = rateAgainstCosting(rate, costing)
  return `${effective} against costing ${formatRate(costing)}${against ? ` (${against})` : ''}`
}

/** "Effective rate ₦1,620.50/$ against costing ₦1,328.10/$ (…)". */
export function rateLine(rate: string | number | null, costing: number | null | undefined): string {
  return `Effective rate ${rateWords(rate, costing)}`
}

/**
 * "₦58,320", or "₦58,320.50" when kobo were paid — exactly what was recorded,
 * never rounded to the naira — or a dash before anything is recorded.
 */
export function formatPaid(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined || !Number.isSafeInteger(kobo)) return '—'
  if (kobo % 100 === 0) return formatNaira(kobo)
  const sign = kobo < 0 ? '−' : ''
  const abs = Math.abs(kobo)
  const naira = Math.floor(abs / 100).toLocaleString('en-GB')
  return `${sign}₦${naira}.${String(abs % 100).padStart(2, '0')}`
}

export type TopupHistoryRow = {
  id: number
  traceId: string
  ngnPaidKobo: number
  reference: string
  supersedesId: number | null
  recordedBy: string
  recordedAt: string
}

/**
 * The records a current top-up replaced, newest first: the one it
 * supersedes, then each `supersedes_id` back from there. The first record
 * stays in history, marked as corrected (§5.2).
 */
export function correctionsOf(
  current: { id?: number | null; supersedesId?: number | null },
  history: readonly TopupHistoryRow[],
): TopupHistoryRow[] {
  const byId = new Map(history.map((row) => [row.id, row]))
  const chain: TopupHistoryRow[] = []
  const seen = new Set<number>(current.id ? [current.id] : [])
  let next = current.supersedesId ?? null
  while (next !== null && !seen.has(next)) {
    seen.add(next)
    const row = byId.get(next)
    if (!row) break
    chain.push(row)
    next = row.supersedesId
  }
  return chain
}
