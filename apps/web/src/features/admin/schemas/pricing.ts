import { z } from 'zod'
import {
  hasDecimals,
  PRICING_FIELDS,
  type PricingField,
  type PricingKey,
} from '@/features/admin/lib/pricing-rules'
import { codeSchema, reasonSchema, requestKeySchema, uuidSchema } from './common'

/**
 * The Pricing & FX actions' inputs (docs/ADMIN-SPEC.md §3.1.2, §5.2 B12),
 * validated before anything else runs (§2.4). The settings' bounds are the
 * ones `admin_update_pricing_settings` holds them to; SQL checks again.
 */

function fieldSchema(key: PricingKey) {
  const field = PRICING_FIELDS.find((each) => each.key === key) as PricingField
  return z
    .number()
    .min(field.min)
    .max(field.max)
    .refine((value) => hasDecimals(value, field.decimals), {
      message: `${field.label}: at most ${field.decimals} decimal places.`,
    })
    .optional()
}

/** Only the keys the wrapper takes — never `vat_pct` — and at least one of them. */
export const pricingChangesSchema = z
  .strictObject({
    margin_ngn: fieldSchema('margin_ngn'),
    fx_buffer_pct: fieldSchema('fx_buffer_pct'),
    icann_fee_cents: fieldSchema('icann_fee_cents'),
    fx_move_threshold_pct: fieldSchema('fx_move_threshold_pct'),
  })
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: 'Change a value to save it.',
  })

/** Save pricing settings (money, owner, `pricing.update`). */
export const updatePricingSchema = z.object({
  changes: pricingChangesSchema,
  reason: reasonSchema,
  requestKey: requestKeySchema,
  code: codeSchema,
})

/** Activate or reject one held rate (money, owner, `fx.activate` / `fx.reject`). */
export const fxRateSchema = z.object({
  rateId: uuidSchema,
  reason: reasonSchema,
  requestKey: requestKeySchema,
  code: codeSchema,
})
