import type { ActiveRate, FxSettings } from '@dr/shared'

/**
 * Converting a stored rate into the shape the pricing functions take.
 *
 * There is deliberately NO constant here. The rate lives in the `fx_rates`
 * table and is read by `getActiveRate()`. A hardcoded fallback would quietly
 * price the catalogue against an invented number — which this project shipped
 * once already, at roughly 19% above the rate the page claimed.
 */
export function toFxSettings(active: ActiveRate): FxSettings {
  return { midRate: active.costingRate, bufferPct: active.bufferPct }
}
