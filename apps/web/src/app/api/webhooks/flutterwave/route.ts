import { type NextRequest, NextResponse } from 'next/server'
import { finalizePayment } from '@/features/checkout/queries/finalize'
import { requirePaymentEnv } from '@/lib/env'
import { webhookHashMatches } from '@/lib/flutterwave'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Flutterwave webhooks (SEC-7). The `verif-hash` header proves the sender;
 * the transaction is then re-read from the API before anything changes, and
 * recording it is idempotent, so retries and replays are harmless.
 *
 * They arrive through Paidly, which passes our status back to Flutterwave
 * (a failure becomes a 502). Flutterwave retries a failed delivery, so:
 *   200 — settled, or nothing we could ever settle (not ours, not a charge);
 *   503 — not settled yet: Flutterwave or our database could not be asked.
 *         Sending it again may work, and a payment must not be dropped;
 *   429 — past a rate limit; also retried.
 * The gateway's sweeper asks Flutterwave about unpaid orders on its own as
 * well, so a charge whose every delivery failed is still found.
 */
/** A charge notice is a few kilobytes; anything far larger is not one. */
const MAX_BODY_BYTES = 64 * 1024
/** Our references are `MDH-<uuid>`; Flutterwave's transaction ids are digits. */
const TX_REF = /^[A-Za-z0-9_-]{1,100}$/
const TRANSACTION_ID = /^\d{1,20}$/

const retryLater = () => NextResponse.json({ ok: false, retry: true }, { status: 503 })

export async function POST(request: NextRequest) {
  const { webhookHash } = requirePaymentEnv()
  if (!webhookHashMatches(request.headers.get('verif-hash'), webhookHash)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  // The hash is a fixed shared secret, not a signature over the body, so the
  // body is treated as a hint: nothing in it is believed until Flutterwave's
  // API confirms it. These limits keep junk from reaching the database.
  const raw = await request.text().catch(() => '')
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false }, { status: 413 })
  }
  let event: { event?: string; data?: { id?: number | string; tx_ref?: string } } | null = null
  try {
    event = JSON.parse(raw)
  } catch {
    event = null
  }
  const id = String(event?.data?.id ?? '')
  const txRef = String(event?.data?.tx_ref ?? '')
  if (event?.event !== 'charge.completed' || !TRANSACTION_ID.test(id) || !TX_REF.test(txRef)) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  const allowed =
    (await withinLimit('webhook:flutterwave', LIMITS.webhookAll)) &&
    (await withinLimit(`webhook:flutterwave:${txRef}`, LIMITS.webhookPerCharge))
  if (!allowed) return NextResponse.json({ ok: false }, { status: 429 })

  const { data: order, error } = await createServiceClient()
    .from('orders')
    .select('id')
    .eq('tx_ref', txRef)
    .maybeSingle()
  if (error) {
    logger.error({ err: error.message }, 'webhook could not look up its order')
    return retryLater()
  }
  if (!order) {
    logger.warn({ event: event.event }, 'webhook for an unknown order')
    return NextResponse.json({ ok: true, ignored: true })
  }

  const outcome = await finalizePayment(order.id, id)
  logger.info({ orderId: order.id, outcome }, 'flutterwave webhook')
  return outcome === 'unverified' ? retryLater() : NextResponse.json({ ok: true })
}
