import 'server-only'

import { vatKobo } from '@dr/shared'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { getSslCatalogue } from '@/features/ssl/queries/catalogue'
import { env, PRICE_LOCK_DEFAULT_MINUTES } from '@/lib/env'
import { type CartTotals, cartTotals, type PricedLine, priceLine } from '../lib/lines'
import { type PricedSslLine, priceSslLine } from '../lib/ssl-lines'
import { currentOwner, findCartId, loadLines, loadSslLines, mergeAnonymousCart } from './store'

export type CartView =
  | { state: 'empty' }
  | { state: 'unpriced' }
  | {
      state: 'ready'
      lines: PricedLine[]
      /** SSL certificates (FR-SSL-6), priced from their own catalogue. */
      certificates: PricedSslLine[]
      totals: CartTotals
      vatPct: number
      lockMinutes: number
    }

/**
 * The cart as the customer sees it, priced now (FR-C4). Request-scoped: it
 * reads the session and the cart cookie, so it renders inside Suspense and is
 * never cached.
 */
export async function getCartView(): Promise<CartView> {
  const { owner, anonToken } = await currentOwner()
  if (!owner) return { state: 'empty' }

  // Signed in with an anonymous cart still in the browser: bring it across.
  if (owner.kind === 'user' && anonToken) await mergeAnonymousCart(anonToken, owner.userId)

  const cartId = await findCartId(owner)
  const [stored, storedSsl] = cartId
    ? await Promise.all([loadLines(cartId), loadSslLines(cartId)])
    : [[], []]
  if (stored.length === 0 && storedSsl.length === 0) return { state: 'empty' }

  const [priced, ssl] = await Promise.all([
    stored.length > 0 ? getPricedCatalogue() : null,
    storedSsl.length > 0 ? getSslCatalogue() : null,
  ])
  // No catalogue, no prices — a cart without prices is worse than none (N5b).
  if ((stored.length > 0 && !priced) || (storedSsl.length > 0 && !ssl)) {
    return { state: 'unpriced' }
  }
  const vatPct = priced?.vatPct ?? ssl?.vatPct ?? 0

  const byTld = new Map(priced?.tlds.map((tld) => [tld.tld, tld]) ?? [])
  const byCode = new Map(ssl?.products.map((product) => [product.productCode, product]) ?? [])
  const now = new Date()
  // Unset only where env validation is skipped, when the default would apply.
  const lockMinutes = env.PRICE_LOCK_MINUTES ?? PRICE_LOCK_DEFAULT_MINUTES
  const lines = stored.map((line) => priceLine(line, byTld.get(line.tld), now, lockMinutes))
  const certificates = storedSsl.map((line) =>
    priceSslLine(line, byCode.get(line.productCode), now, lockMinutes),
  )

  return {
    state: 'ready',
    lines,
    certificates,
    totals: cartTotals(lines, (amount) => vatKobo(amount, vatPct), certificates),
    vatPct,
    lockMinutes,
  }
}
