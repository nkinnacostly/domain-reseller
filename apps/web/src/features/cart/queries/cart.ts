import 'server-only'

import { vatKobo } from '@dr/shared'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env } from '@/lib/env'
import { type CartTotals, cartTotals, type PricedLine, priceLine } from '../lib/lines'
import { currentOwner, findCartId, loadLines, mergeAnonymousCart } from './store'

export type CartView =
  | { state: 'empty' }
  | { state: 'unpriced' }
  | { state: 'ready'; lines: PricedLine[]; totals: CartTotals; vatPct: number; lockMinutes: number }

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
  const stored = cartId ? await loadLines(cartId) : []
  if (stored.length === 0) return { state: 'empty' }

  const priced = await getPricedCatalogue()
  // No catalogue, no prices — a cart without prices is worse than none (N5b).
  if (!priced) return { state: 'unpriced' }

  const byTld = new Map(priced.tlds.map((tld) => [tld.tld, tld]))
  const now = new Date()
  const lines = stored.map((line) =>
    priceLine(line, byTld.get(line.tld), now, env.PRICE_LOCK_MINUTES),
  )

  return {
    state: 'ready',
    lines,
    totals: cartTotals(lines, (amount) => vatKobo(amount, priced.vatPct)),
    vatPct: priced.vatPct,
    lockMinutes: env.PRICE_LOCK_MINUTES,
  }
}
