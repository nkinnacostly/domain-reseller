import { PLACEHOLDER_FX } from '@dr/shared'

/**
 * FX used for every displayed price.
 *
 * Re-exported from @dr/shared rather than redeclared. This module previously
 * carried its own `{ midRate: 1550 }` literal alongside the shared one — two
 * constants that could drift, which is exactly the bug that let the home page
 * and the pricing page quote different prices.
 *
 * The rate is a FIXED figure, not a feed. There is no `fx_rates` table and no
 * daily job yet (PRD FR-FX-1/2), so nothing on this site may claim the rate
 * tracks the market or updates on a schedule — it does neither.
 */
export const FX = PLACEHOLDER_FX

/** The rate customers are actually charged at, after the buffer. */
export const EFFECTIVE_RATE = Math.round(FX.midRate * (1 + FX.bufferPct / 100))
