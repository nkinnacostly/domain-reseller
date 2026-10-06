import 'server-only'

import { webhookSealKey } from '@dr/shared/webhooks'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * MR6, §9: the key that seals each endpoint's signing secret, or null —
 * logged once per call. Without it no endpoint is made or rotated, never one
 * with a plain secret, and the person is told it is ours to fix.
 */
export function webhookKey(): Uint8Array | null {
  const key = webhookSealKey(env.MAIL_WEBHOOK_SECRET_KEY)
  if (!key) logger.error({}, 'MAIL_WEBHOOK_SECRET_KEY is missing or not 32 bytes of base64')
  return key
}

export const NO_SEAL_KEY =
  'Webhooks cannot be set up right now: this is on our side. Nothing was saved; try again later.'
