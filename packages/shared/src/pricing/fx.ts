/**
 * Exchange rate handling.
 *
 * Rates come from live market feeds. Two independent sources are fetched and
 * cross-checked: if they disagree materially one of them is wrong, and pricing
 * the whole catalogue off a wrong rate is worse than not updating today.
 */

export const FX_SOURCES = ['er-api', 'currency-api', 'aboki-parallel', 'manual'] as const
export type FxSource = (typeof FX_SOURCES)[number]

export type RateQuote = {
  source: FxSource
  /** Naira per dollar. */
  rate: number
  quotedAt: Date
}

/** Two sources further apart than this mean one of them is wrong. */
export const DEFAULT_CROSS_CHECK_TOLERANCE_PCT = 2

/** A single update moving more than this is held for a human to look at. */
export const DEFAULT_MOVE_THRESHOLD_PCT = 5

export type CrossCheck =
  | { agreed: true; rate: number; spreadPct: number }
  | { agreed: false; spreadPct: number; reason: string }

/**
 * Reconcile several independent quotes into one rate.
 *
 * Uses the median so a single bad feed cannot drag the result, and refuses
 * outright when the spread is too wide to call.
 */
export function crossCheckQuotes(
  quotes: RateQuote[],
  tolerancePct: number = DEFAULT_CROSS_CHECK_TOLERANCE_PCT,
): CrossCheck {
  const rates = quotes
    .map((q) => q.rate)
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b)

  if (rates.length === 0) {
    return { agreed: false, spreadPct: 0, reason: 'No usable quotes' }
  }
  if (rates.length === 1) {
    return { agreed: true, rate: rates[0] as number, spreadPct: 0 }
  }

  const low = rates[0] as number
  const high = rates[rates.length - 1] as number
  const spreadPct = ((high - low) / low) * 100

  if (spreadPct > tolerancePct) {
    return {
      agreed: false,
      spreadPct,
      reason: `Sources disagree by ${spreadPct.toFixed(2)}% (${low} vs ${high}), beyond ${tolerancePct}%`,
    }
  }

  const middle = Math.floor(rates.length / 2)
  const median =
    rates.length % 2 === 1
      ? (rates[middle] as number)
      : ((rates[middle - 1] as number) + (rates[middle] as number)) / 2

  return { agreed: true, rate: median, spreadPct }
}

export type RateDecision =
  | { action: 'accept'; movePct: number }
  | { action: 'hold_for_review'; movePct: number; reason: string }
  | { action: 'reject'; reason: string }

/**
 * A large single move is stored but not applied. A bad feed, a decimal slip or
 * a genuine shock should not silently reprice the catalogue unattended.
 */
export function evaluateRateChange(
  currentRate: number | null,
  incomingRate: number,
  thresholdPct: number = DEFAULT_MOVE_THRESHOLD_PCT,
): RateDecision {
  if (!Number.isFinite(incomingRate) || incomingRate <= 0) {
    return { action: 'reject', reason: 'Incoming rate is not a positive number' }
  }

  if (currentRate === null) {
    return { action: 'hold_for_review', movePct: 0, reason: 'First rate — no baseline to compare' }
  }

  const movePct = ((incomingRate - currentRate) / currentRate) * 100

  if (Math.abs(movePct) > thresholdPct) {
    return {
      action: 'hold_for_review',
      movePct,
      reason: `Moved ${movePct.toFixed(2)}% in one update, beyond the ${thresholdPct}% threshold`,
    }
  }

  return { action: 'accept', movePct }
}
