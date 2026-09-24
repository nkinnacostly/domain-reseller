import { type NextRequest, NextResponse } from 'next/server'
import { finalizePayment, markOrderCancelled } from '@/features/checkout/queries/finalize'
import { getOrder } from '@/features/checkout/queries/orders'
import { LIMITS, withinLimit } from '@/lib/rate-limit'

/**
 * Where Flutterwave sends the customer back. The query string says what
 * happened, but it is written by the browser, so it decides nothing: a
 * successful-looking return is verified with Flutterwave before the order
 * moves (SEC-7).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const orderId = url.searchParams.get('order') ?? ''
  const status = url.searchParams.get('status')
  const transactionId = url.searchParams.get('transaction_id')

  // RLS: only the owner can see the order, so nobody settles someone else's.
  const order = await getOrder(orderId)
  if (!order) return NextResponse.redirect(new URL('/app/orders', url.origin))

  const toOrder = (payment: string) =>
    NextResponse.redirect(new URL(`/app/orders/${order.id}?payment=${payment}`, url.origin))

  if (status === 'cancelled') {
    await markOrderCancelled(order.id)
    return toOrder('cancelled')
  }
  if (!transactionId) return toOrder('pending')

  // Each return makes a Flutterwave call. Past either limit the order simply
  // waits: the webhook and the sweeper still settle it, so nothing is lost.
  const allowed =
    (await withinLimit(`checkout_return:${order.id}`, LIMITS.checkoutReturn)) &&
    (await withinLimit(`checkout_return_user:${order.user_id}`, LIMITS.checkoutReturnAccount))
  if (!allowed) return toOrder('pending')

  const outcome = await finalizePayment(order.id, transactionId)
  return toOrder(outcome === 'unverified' ? 'pending' : outcome)
}
