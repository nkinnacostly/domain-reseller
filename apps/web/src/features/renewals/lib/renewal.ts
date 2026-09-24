import type { LocalStatus } from '@dr/shared'
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

export type Renewability = { ok: true; maxYears: number } | { ok: false; reason: string }

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
    /** The extension's longest registration period, from the catalogue. */
    tldMaxPeriod: number | null
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
  if (options.tldMaxPeriod === null) {
    return { ok: false, reason: 'Renewal prices for this extension are unavailable right now.' }
  }

  const limit = addYears(options.now, MAX_YEARS_AHEAD)
  let maxYears = 0
  for (let years = 1; years <= Math.min(options.tldMaxPeriod, MAX_YEARS_AHEAD); years += 1) {
    if (addYears(domain.expiresAt, years) <= limit) maxYears = years
  }
  if (maxYears === 0) {
    return {
      ok: false,
      reason: `It’s already registered for as long as a registry allows — ${MAX_YEARS_AHEAD} years ahead.`,
    }
  }
  return { ok: true, maxYears }
}

/**
 * What a renewal costs us at the supplier, in USD — for the float pre-flight
 * (FR-C8): the renewal price each year, plus the ICANN fee on generic
 * extensions.
 */
export function renewalCostUsd(
  cost: { renewUsd: number; isCountryCode: boolean },
  years: number,
  icannFeeUsd: number,
): number {
  const perYear = cost.renewUsd + (cost.isCountryCode ? 0 : icannFeeUsd)
  return Math.round(perYear * years * 100) / 100
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
