import 'server-only'

import { logger } from '@/lib/logger'
import { MAIL_TX_REF_PREFIX, readWebhook } from '../lib/flutterwave'
import { paymentsConfigured, requireBillingEnv } from './env'
import { webhookHashMatches } from './flutterwave'
import { settleCharge } from './settle'

/** A charge notice is a few kilobytes; anything far larger is not one. */
export const MAX_WEBHOOK_BYTES = 64 * 1024

export type WebhookAnswer = { status: number; body: Record<string, unknown> }

const settled = (extra: Record<string, unknown> = {}): WebhookAnswer => ({
  status: 200,
  body: { ok: true, ...extra },
})
const retryLater: WebhookAnswer = { status: 503, body: { ok: false, retry: true } }

/**
 * The webhook's decision, apart from Next so it is tested on its own. The
 * hash proves the sender; the body is only a hint — the charge is re-read from
 * Flutterwave before anything changes, and recording it is idempotent, so a
 * replay or a retry is harmless. Only `charge.completed` names a charge:
 * `subscription.cancelled` carries no reference to route by, and a renewal
 * that never comes is caught by the hourly sweep (owner, 6 Oct 2026).
 */
export async function handleFlutterwaveWebhook(
  verifHash: string | null,
  raw: string,
): Promise<WebhookAnswer> {
  // Not set up yet: nothing can be verified, so ask Flutterwave to send it again.
  if (!paymentsConfigured()) return retryLater
  const { webhookHash } = requireBillingEnv()
  if (!webhookHashMatches(verifHash, webhookHash)) return { status: 401, body: { ok: false } }
  if (raw.length > MAX_WEBHOOK_BYTES) return { status: 413, body: { ok: false } }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  const notice = readWebhook(parsed)
  if (
    notice.event !== 'charge.completed' ||
    !notice.transactionId ||
    !notice.txRef?.startsWith(MAIL_TX_REF_PREFIX)
  ) {
    return settled({ ignored: true })
  }

  const outcome = await settleCharge(notice.transactionId)
  logger.info({ outcome, transactionId: notice.transactionId }, 'flutterwave webhook')
  return outcome === 'unverified' ? retryLater : settled()
}
