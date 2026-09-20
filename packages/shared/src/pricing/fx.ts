/**
 * Exchange rate handling.
 *
 * We buy US dollars on the parallel market to fund the supplier balance, so
 * the rate that matters is what a dealer SELLS dollars to us for — not the
 * buy rate, and not the midpoint. Costing off `buy` or the mid would
 * understate our cost on every single domain.
 */

export const FX_SOURCES = ['aboki-parallel', 'manual', 'official'] as const
export type FxSource = (typeof FX_SOURCES)[number]

export type RateQuote = {
  source: FxSource
  /** What a dealer pays to buy dollars from you. */
  buy: number
  /** What a dealer charges to sell dollars to you — our cost basis. */
  sell: number
  /** When the provider says the quote was taken. */
  quotedAt: Date
}

/** The rate we actually cost against. */
export function costingRate(quote: Pick<RateQuote, 'buy' | 'sell'>): number {
  if (quote.sell <= 0) throw new RangeError('Sell rate must be positive')
  if (quote.buy > quote.sell) {
    // A dealer never sells cheaper than they buy. Inverted fields mean the
    // provider changed its shape, and costing off it would be silently wrong.
    throw new RangeError('Buy rate above sell rate — provider response looks inverted')
  }
  return quote.sell
}

/**
 * FR-FX-5 — a large single move is held for review rather than applied.
 *
 * A bad feed, a decimal slip or a market shock should not silently reprice the
 * whole catalogue. Anything beyond the threshold is stored but not activated,
 * and someone looks at it.
 */
export const DEFAULT_MOVE_THRESHOLD_PCT = 5

export type RateDecision =
  | { action: 'accept'; movePct: number }
  | { action: 'hold_for_review'; movePct: number; reason: string }
  | { action: 'reject'; reason: string }

export function evaluateRateChange(
  currentRate: number | null,
  incomingRate: number,
  thresholdPct: number = DEFAULT_MOVE_THRESHOLD_PCT,
): RateDecision {
  if (!Number.isFinite(incomingRate) || incomingRate <= 0) {
    return { action: 'reject', reason: 'Incoming rate is not a positive number' }
  }

  // No rate yet: the first one has nothing to be compared against, and someone
  // should look at it before the catalogue prices against it.
  if (currentRate === null) {
    return { action: 'hold_for_review', movePct: 0, reason: 'First rate — no baseline to compare' }
  }

  const movePct = ((incomingRate - currentRate) / currentRate) * 100

  if (Math.abs(movePct) > thresholdPct) {
    return {
      action: 'hold_for_review',
      movePct,
      reason: `Moved ${movePct.toFixed(1)}% in one update, beyond the ${thresholdPct}% threshold`,
    }
  }

  return { action: 'accept', movePct }
}

/**
 * The rate the storefront prices against, plus the buffer.
 *
 * The buffer covers the gap between quoting a price and actually settling the
 * dollars — the rate can move in between, and the supplier balance is funded
 * in batches rather than per order.
 */
export type ActiveRate = {
  costingRate: number
  bufferPct: number
  source: FxSource
  effectiveFrom: Date
}

export function effectiveRateFrom(active: ActiveRate): number {
  return active.costingRate * (1 + active.bufferPct / 100)
}
