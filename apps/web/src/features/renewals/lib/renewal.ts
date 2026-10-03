import { type LocalStatus, renewalTotalKobo, vatKobo } from '@dr/shared'
import { type LineCost, lineCostUsd, type UsdAmount } from '@/features/checkout/lib/cost'
import { periodsText } from '@/features/pricing/lib/terms'
import { BUSINESS } from '@/lib/business'

/**
 * Whether a domain can be renewed from the panel, and for how long (PRD E8,
 * FR-RN1, FR-RN5). Pure, so every rule is testable.
 *
 * A registry holds a domain at most ten years ahead, so the years on offer
 * stop where the new expiry would pass that. A domain in its grace period
 * renews at the normal price (§7.5); one in redemption needs a restore, which
 * costs far more and is not online yet (FR-RN6).
 */

export const MAX_YEARS_AHEAD = 10

export type RenewableDomain = {
  source: 'registration' | 'transfer' | 'demo'
  status: LocalStatus
  testMode: boolean
  expiresAt: string | null
}

/**
 * `years`: every renewal the registry sells that fits under the ten-year
 * limit, ascending — 1 to 10 for most, 2, 4, 6… for .ai. `maxYears` is the
 * longest of them.
 */
export type Renewability =
  | { ok: true; maxYears: number; years: number[] }
  | { ok: false; reason: string }

export function addYears(date: Date | string, years: number): Date {
  const next = new Date(date)
  next.setUTCFullYear(next.getUTCFullYear() + years)
  return next
}

export function renewability(
  domain: RenewableDomain,
  options: {
    /** The payment keys' side: true for test keys, null when payments are not set up. */
    paymentTestMode: boolean | null
    /** The renewal periods the extension is sold in, from the catalogue; null without a price. */
    renewPeriods: readonly number[] | null
    /** A renewal of this domain is already paid for and being made. */
    inProgress: boolean
    now: Date
  },
): Renewability {
  if (domain.source === 'demo') {
    return { ok: false, reason: 'Demo domains can’t be renewed.' }
  }
  if (domain.status === 'redemption') {
    return {
      ok: false,
      reason: `This domain has passed its grace period and is in redemption. Getting it back is a restore, which costs more than a renewal and can’t be done online yet — email ${BUSINESS.email} and we’ll quote it.`,
    }
  }
  if (domain.status === 'pending_delete') {
    return {
      ok: false,
      reason: 'The registry is deleting this domain, and it can no longer be renewed.',
    }
  }
  if ((domain.status !== 'active' && domain.status !== 'expired_grace') || !domain.expiresAt) {
    return { ok: false, reason: 'Only a registered domain can be renewed.' }
  }
  if (options.paymentTestMode === null) {
    return { ok: false, reason: 'Payments aren’t set up here, so renewals are paused.' }
  }
  if (domain.testMode !== options.paymentTestMode) {
    return {
      ok: false,
      reason: domain.testMode
        ? 'This domain is in the registrar’s test system, so it can’t be renewed with a real payment.'
        : 'Renewing a live domain needs live payments, which aren’t switched on here.',
    }
  }
  if (options.inProgress) {
    return { ok: false, reason: 'A renewal of this domain is already paid for and being made.' }
  }
  if (options.renewPeriods === null || options.renewPeriods.length === 0) {
    return { ok: false, reason: 'Renewal prices for this extension are unavailable right now.' }
  }

  const limit = addYears(options.now, MAX_YEARS_AHEAD)
  const expiresAt = domain.expiresAt
  const years = options.renewPeriods.filter(
    (period) => period <= MAX_YEARS_AHEAD && addYears(expiresAt, period) <= limit,
  )
  const maxYears = years.at(-1)
  if (maxYears === undefined) {
    const shortest = options.renewPeriods[0] ?? 1
    return {
      ok: false,
      reason:
        shortest === 1
          ? `It’s already registered for as long as a registry allows — ${MAX_YEARS_AHEAD} years ahead.`
          : `Its registry renews it only ${shortest} years at a time, and ${shortest} more would take it past the ${MAX_YEARS_AHEAD} years ahead a registry allows. It can be renewed once it is ${MAX_YEARS_AHEAD - shortest} years or less from expiry.`,
    }
  }
  return { ok: true, maxYears, years }
}

/**
 * Why `requested` years cannot be bought now, or null when they can — what
 * the renewal actions tell someone whose choice is not on offer (N9b).
 */
export function renewalYearsRefusal(
  check: { maxYears: number; years: readonly number[] },
  requested: number,
  subject = 'This domain',
): string | null {
  if (check.years.includes(requested)) return null
  if (requested > check.maxYears) {
    return `${subject} can be renewed for at most ${check.maxYears} ${check.maxYears === 1 ? 'year' : 'years'} now.`
  }
  return `${subject} can be renewed for ${periodsText(check.years)} at a time.`
}

/**
 * What a renewal costs us at the supplier, in integer cents — for the float
 * pre-flight (FR-C8) and the line's `order_item_costs` row (ADMIN-SPEC §6):
 * the renewal price each year, plus the ICANN fee each year on generic
 * extensions, split out.
 */
export function renewalCostUsd(
  cost: { renewUsd: UsdAmount; isCountryCode: boolean },
  years: number,
  icannFeeUsd: UsdAmount,
): LineCost {
  return lineCostUsd({ kind: 'renew', years, ...cost }, icannFeeUsd)
}

/**
 * FR-P4, FR-P5 — several domains renewed in one order, paid once. The ids
 * travel in the address, so the page can be reloaded and shared with
 * yourself; 100 of them is under 4 KB, and an order that size is already
 * more than one payment should carry.
 */
export const BULK_RENEW_MAX = 100

export function bulkRenewHref(domainIds: readonly string[]): string {
  return `/app/domains/renew?ids=${domainIds.join(',')}`
}

/** `?ids=` back to a list: distinct, in order, only what looks like an id. */
export function parseRenewIds(value: string | undefined): string[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => uuid.test(id)),
    ),
  ]
}

/**
 * The years every renewable domain in a bulk renewal can take: the same for
 * all, so only the periods each of them is sold in and has room for — a mix
 * of .com and .ai renews in 2, 4, 6… years. Null when none is renewable;
 * empty when they share no period.
 */
export function sharedYears(checks: readonly Renewability[]): number[] | null {
  const lists = checks.flatMap((check) => (check.ok ? [check.years] : []))
  const [first, ...rest] = lists
  if (!first) return null
  return first.filter((years) => rest.every((list) => list.includes(years)))
}

/**
 * A bulk renewal's money (N5: kobo, integers): each line exactly as the
 * one-domain renewal prices it — its renewal price times the years — and
 * VAT once on the subtotal, as checkout charges it.
 */
export function bulkRenewalTotals(
  pricings: readonly { renewal: { priceKobo: number }; renewPeriods: readonly number[] }[],
  years: number,
  vatPct: number,
): { lineKobo: number[]; subtotalKobo: number; vatKobo: number; totalKobo: number } {
  const lineKobo = pricings.map((pricing) => renewalTotalKobo(pricing, years))
  const subtotalKobo = lineKobo.reduce((sum, kobo) => sum + kobo, 0)
  const vat = vatKobo(subtotalKobo, vatPct)
  return { lineKobo, subtotalKobo, vatKobo: vat, totalKobo: subtotalKobo + vat }
}

/** A JSON value with its keys in a fixed order, so two contacts compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * The registrant a renewal order records — the customer on its receipt. One
 * domain's own, as a single renewal records it; for several, theirs when
 * they all share it, else null (the caller uses the account's own details).
 */
export function sharedRegistrant(registrants: readonly unknown[]): Record<string, unknown> | null {
  const [first] = registrants
  if (!first || typeof first !== 'object') return null
  const key = canonical(first)
  return registrants.every((registrant) => canonical(registrant) === key)
    ? (first as Record<string, unknown>)
    : null
}

/** The customer Flutterwave shows: the registrant's name, else the account's email. */
export function paymentCustomer(
  registrant: Record<string, string | undefined> | null,
  email: string | null | undefined,
): { email: string; name: string; phone?: string } {
  const contact = registrant ?? {}
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  return {
    email: email ?? contact.email ?? '',
    name: name || (email ?? 'Customer'),
    ...(contact.phone ? { phone: `+${contact.phoneCountryCode ?? ''}${contact.phone}` } : {}),
  }
}

/**
 * FR-RN7: a renewal price higher than the one the customer last paid or was
 * promised is said out loud, before they pay.
 */
export function priceRise(
  previousKobo: number | null,
  currentKobo: number,
): { from: number; to: number } | null {
  return previousKobo !== null && currentKobo > previousKobo
    ? { from: previousKobo, to: currentKobo }
    : null
}
