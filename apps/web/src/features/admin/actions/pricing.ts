'use server'

import { revalidateTag } from 'next/cache'
import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { fxRateSchema, updatePricingSchema } from '@/features/admin/schemas/pricing'
import { adminMoneyAction } from '@/lib/safe-action'

/**
 * The owner's pricing actions (docs/ADMIN-SPEC.md §3.1.2, §5.2 B12): saving
 * the pricing settings, and activating or rejecting a rate the FX job held.
 * Each is a money action: the dialog's code is verified against this
 * session's own factor before SQL sees anything (D6), and an operator or a
 * test administrator is refused with the role's words before that. One
 * audited `admin_*` wrapper then decides, with the session client — never a
 * table (N5b: pricing inputs change only through them).
 *
 * The storefront caches every price under the `pricing` tag (as the price
 * list apply and /api/pricing/refresh do), so a change that reprices the
 * site expires it at once rather than within the day.
 */

type Answer = { data: unknown; error: { message: string } | null }

/** A wrapper's answer in words; an error that is not a refusal is thrown, so the dialog keeps its key. */
function answered({ data, error }: Answer): AdminResult {
  if (error) throw adminAccessError(error.message)
  return toAdminResult(data)
}

/** Prices on the site are built from what changed: expire them now (N5b). */
function repriced(result: AdminResult): AdminResult {
  if (result.ok) revalidateTag('pricing', { expire: 0 })
  return result
}

/** Save pricing settings (`pricing.update`): margin, FX buffer, ICANN fee, move threshold. */
export const updatePricingSettings = adminMoneyAction('pricing.update', updatePricingSchema).action(
  async ({ parsedInput, ctx }) =>
    repriced(
      answered(
        await ctx.db.rpc('admin_update_pricing_settings', {
          p_changes: parsedInput.changes,
          p_reason: parsedInput.reason,
          p_request_key: parsedInput.requestKey,
        }),
      ),
    ),
)

/** Activate a held rate (`fx.activate`): every price on the site is built from it next. */
export const activateFxRate = adminMoneyAction('fx.activate', fxRateSchema).action(
  async ({ parsedInput, ctx }) =>
    repriced(
      answered(
        await ctx.db.rpc('admin_activate_fx_rate', {
          p_rate_id: parsedInput.rateId,
          p_reason: parsedInput.reason,
          p_request_key: parsedInput.requestKey,
        }),
      ),
    ),
)

/**
 * Reject a held rate (`fx.reject`). The storefront reads only the active
 * rate, so no price changes and nothing is expired.
 */
export const rejectFxRate = adminMoneyAction('fx.reject', fxRateSchema).action(
  async ({ parsedInput, ctx }) =>
    answered(
      await ctx.db.rpc('admin_reject_fx_rate', {
        p_rate_id: parsedInput.rateId,
        p_reason: parsedInput.reason,
        p_request_key: parsedInput.requestKey,
      }),
    ),
)
