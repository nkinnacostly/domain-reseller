'use server'

import { sslHostnameSchema, supplierName } from '@dr/shared'
import { z } from 'zod'
import { getSslCatalogue } from '@/features/ssl/queries/catalogue'
import { sslNameInUse } from '@/features/ssl/queries/names'
import { logger } from '@/lib/logger'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'
import { actionClient } from '@/lib/safe-action'
import { MAX_CART_ITEMS } from '../lib/lines'
import { existingCartId, ownerForWrite, setCountCookie } from '../queries/owner'
import { countLines, deleteSslLine, findOrCreateCartId, insertSslLine } from '../queries/store'

/**
 * SSL certificates in the cart (FR-SSL-6). Public, like domains: anyone may
 * fill a cart and sign in at checkout. The price comes from our catalogue,
 * never the browser; the name is checked before it is quoted, because the
 * supplier will sell a certificate for anything — "not a domain" included.
 */

type Failure = { error: string }
const FAILED = 'Something went wrong updating your cart. Please try again.'

export const addSslToCart = actionClient
  .inputSchema(
    z.object({
      productCode: z.string().regex(/^[A-Za-z0-9]{1,16}$/),
      name: z.string().min(1).max(260),
    }),
  )
  .action(async ({ parsedInput }): Promise<Failure | { count: number; name: string }> => {
    const host = sslHostnameSchema.safeParse(parsedInput.name)
    if (!host.success) {
      return {
        error: host.error.issues[0]?.message ?? 'That is not a name a certificate can be for.',
      }
    }
    if (!(await withinLimit(await addressKey('ssl_add'), LIMITS.bulkAddToCart))) {
      return { error: "You've added a lot in the last few minutes. Wait a little and try again." }
    }

    const catalogue = await getSslCatalogue()
    const product = catalogue?.products.find(
      (entry) => entry.productCode === parsedInput.productCode,
    )
    if (!catalogue) return { error: 'Prices are unavailable right now, so nothing can be added.' }
    if (!product) return { error: 'We do not sell that certificate.' }

    // The supplier knows a certificate by its name only, and reaches only the
    // first on a name: one we already hold blocks another (Appendix E).
    const name = supplierName(host.data, product.isWildcard)
    const inUse = await sslNameInUse(name)
    if (inUse === null)
      return { error: "We couldn't check that name just now. Try again in a moment." }
    if (inUse) {
      return {
        error: `A certificate for ${name} was already bought through us. If it is yours, reissue it from your account; otherwise contact us.`,
      }
    }

    try {
      const cartId = await findOrCreateCartId(await ownerForWrite())
      if ((await countLines(cartId)) >= MAX_CART_ITEMS) {
        return { error: `A cart holds up to ${MAX_CART_ITEMS} items. Check out these first.` }
      }
      await insertSslLine(cartId, {
        productCode: product.productCode,
        commonName: name,
        quotedTotalKobo: product.price.priceKobo,
        quotedFxRateId: catalogue.rateId,
      })
      const count = await countLines(cartId)
      await setCountCookie(count)
      return { count, name }
    } catch (err) {
      logger.error({ err }, 'add certificate to cart failed')
      return { error: FAILED }
    }
  })

export const removeSslCartLine = actionClient
  .inputSchema(z.object({ lineId: z.uuid() }))
  .action(async ({ parsedInput }): Promise<Failure | { count: number }> => {
    try {
      const cartId = await existingCartId()
      if (!cartId) return { count: 0 }
      await deleteSslLine(cartId, parsedInput.lineId)
      const count = await countLines(cartId)
      await setCountCookie(count)
      return { count }
    } catch (err) {
      logger.error({ err }, 'cart certificate remove failed')
      return { error: FAILED }
    }
  })
