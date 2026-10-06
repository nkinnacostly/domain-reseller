import { type NextRequest, NextResponse } from 'next/server'
import { handleFlutterwaveWebhook } from '@/features/billing/server/webhook'

/**
 * Flutterwave's webhook for Mail's plans (MAIL-SPEC §8, SEC-7). It arrives
 * through Paidly, which forwards every `MDM-` reference here with the
 * account's `verif-hash`, and passes our status back to Flutterwave:
 *   200 — settled, or nothing we could ever settle;
 *   503 — not settled yet (Flutterwave or our database could not be asked):
 *         Flutterwave sends it again, and a payment is never dropped.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text().catch(() => '')
  const { status, body } = await handleFlutterwaveWebhook(request.headers.get('verif-hash'), raw)
  return NextResponse.json(body, { status })
}
