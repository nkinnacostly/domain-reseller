'use server'

import { revalidateTag } from 'next/cache'
import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { sslSellableSchema } from '@/features/admin/schemas/settings'
import { adminMoneyAction } from '@/lib/safe-action'

/**
 * Put an SSL product on sale or take it off (docs/ADMIN-SPEC.md §3.1.2
 * `admin_set_ssl_sellable`, §5.2 B13). `is_sellable` is the owner's choice
 * and the one column the weekly sync never writes (CLAUDE.md §15): owner,
 * money tier, the dialog's code verified first (D6). A product with no
 * price is refused on (`NO_PRICE`). Certificate prices are cached under
 * `pricing`, so they are expired after a change that went through (N5b).
 */
export const setSslSellable = adminMoneyAction('ssl_product.sellable', sslSellableSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> => {
    const { data, error } = await ctx.db.rpc('admin_set_ssl_sellable', {
      p_product_code: parsedInput.productCode,
      p_sellable: parsedInput.sellable,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    })
    if (error) throw adminAccessError(error.message)
    const result = toAdminResult(data)
    if (result.ok) revalidateTag('pricing', { expire: 0 })
    return result
  },
)
