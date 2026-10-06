import { type NextRequest, NextResponse } from 'next/server'
import { getCheckout } from '@/features/billing/queries/billing'
import { returnFromCheckout } from '@/features/billing/server/return'

/**
 * Where Flutterwave sends someone back after a checkout (MAIL-SPEC §8). The
 * query string is written by the browser, so it decides nothing: a
 * successful-looking return is re-read from Flutterwave before anything
 * changes (SEC-7). Under /dashboard, so the proxy has refreshed the session;
 * only the account's owners and admins can see the checkout (RLS).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const checkout = await getCheckout(url.searchParams.get('checkout') ?? '')
  const outcome = await returnFromCheckout(checkout, {
    status: url.searchParams.get('status'),
    transactionId: url.searchParams.get('transaction_id'),
  })
  const target = new URL('/dashboard/billing', url.origin)
  if (outcome) target.searchParams.set('payment', outcome)
  return NextResponse.redirect(target)
}
