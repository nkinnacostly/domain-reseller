import 'server-only'

import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Per-account limits on the payment path (SEC-11, PRD R15). Counted in
 * Postgres, so every serverless instance and region sees the same count.
 *
 * Fails closed: if the count cannot be read, the action is refused. For
 * something that moves money, "try again in a moment" beats unmetered.
 */
export const LIMITS = {
  // Each attempt re-checks availability and the float with the supplier and
  // opens a Flutterwave payment: generous for a person, tight for a script.
  placeOrder: { max: 10, windowSeconds: 600 },
  placeOrderDaily: { max: 40, windowSeconds: 86_400 },
  // Each return re-reads a transaction from Flutterwave: per order, and per
  // account so many small orders cannot be used to multiply the calls.
  checkoutReturn: { max: 30, windowSeconds: 600 },
  checkoutReturnAccount: { max: 60, windowSeconds: 600 },
  // Webhooks carry our shared secret, so these only bite if it leaks or
  // Flutterwave misbehaves: one charge is not settled a hundred times over.
  webhookPerCharge: { max: 20, windowSeconds: 600 },
  webhookAll: { max: 600, windowSeconds: 60 },
  // Anyone may ask for a price refresh; it only acts when prices really changed.
  pricingRefresh: { max: 12, windowSeconds: 3600 },
} as const

export async function withinLimit(
  key: string,
  limit: { max: number; windowSeconds: number },
): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('rate_limit_hit', {
    p_key: key,
    p_max: limit.max,
    p_window_seconds: limit.windowSeconds,
  })
  if (error) {
    logger.error({ err: error.message }, 'rate limit could not be checked; refusing')
    return false
  }
  return data === true
}
