import type { FxSettings } from '@dr/shared'

/**
 * FX used for every displayed price.
 *
 * PLACEHOLDER until the `fx_rates` table and the daily update job exist
 * (PRD FR-FX-1/2). One module so the home page and the pricing page can never
 * quote different rates — replace the constant with a query and everything
 * downstream keeps working.
 */
export const FX: FxSettings = { midRate: 1550, bufferPct: 4 }

export const FX_UPDATED_LABEL = 'updated daily at 08:00 WAT'
