import { type NextRequest, NextResponse } from 'next/server'
import { finalizePayment } from '@/features/checkout/queries/finalize'
import { requirePaymentEnv } from '@/lib/env'
import { webhookHashMatches } from '@/lib/flutterwave'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Flutterwave webhooks (SEC-7). The `verif-hash` header proves the sender;
 * the transaction is then re-read from the API before anything changes, and
 * recording it is idempotent, so retries and replays are harmless.
 *
 * Flutterwave wants a 200 within 60 seconds and retries three times, 30
 * minutes apart. We answer 200 once the sender is proven — a payment we
 * cannot match is logged for ops, not bounced back for retries.
 */
export async function POST(request: NextRequest) {
  const { webhookHash } = requirePaymentEnv()
  if (!webhookHashMatches(request.headers.get('verif-hash'), webhookHash)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  const event = (await request.json().catch(() => null)) as {
    event?: string
    data?: { id?: number | string; tx_ref?: string }
  } | null
  if (event?.event !== 'charge.completed' || !event.data?.id || !event.data.tx_ref) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  const { data: order } = await createServiceClient()
    .from('orders')
    .select('id')
    .eq('tx_ref', event.data.tx_ref)
    .maybeSingle()
  if (!order) {
    logger.warn({ event: event.event }, 'webhook for an unknown order')
    return NextResponse.json({ ok: true, ignored: true })
  }

  const outcome = await finalizePayment(order.id, String(event.data.id))
  logger.info({ orderId: order.id, outcome }, 'flutterwave webhook')
  return NextResponse.json({ ok: true })
}
