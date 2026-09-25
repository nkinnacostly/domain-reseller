import 'server-only'

import { createSesClient, SES_ATTENTION } from '@dr/shared/ses'
import { BUSINESS } from '@/lib/business'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import type { OutgoingEmail, SendResult } from './types'

/**
 * Sends one email through Amazon SES (API v2, L1) when EMAIL_PROVIDER=ses:
 * the same From and Reply-To as Brevo, in the configuration set whose event
 * destination reports deliveries to /api/email/ses-events.
 *
 * Addresses and content never reach a log line (N13) — the outcome, SES's
 * message id and error type, and the email's tags.
 */

const TIMEOUT_MS = 10_000

const SETTINGS = [
  'AWS_SES_REGION',
  'AWS_SES_ACCESS_KEY_ID',
  'AWS_SES_SECRET_ACCESS_KEY',
  'AWS_SES_CONFIGURATION_SET',
] as const

export async function sendWithSes(email: OutgoingEmail): Promise<SendResult> {
  const region = env.AWS_SES_REGION
  const accessKeyId = env.AWS_SES_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SES_SECRET_ACCESS_KEY
  const configurationSet = env.AWS_SES_CONFIGURATION_SET
  if (!region || !accessKeyId || !secretAccessKey || !configurationSet) {
    // Names, never values (N13).
    const missing = SETTINGS.filter((name) => !env[name])
    logger.error({ missing }, 'SES is not configured: email not sent')
    return { ok: false, status: 500 }
  }

  const ses = createSesClient({
    region,
    accessKeyId,
    secretAccessKey,
    configurationSet,
    from: { name: BUSINESS.brand, email: BUSINESS.noReplyEmail },
    replyTo: { name: BUSINESS.brand, email: BUSINESS.email },
    timeoutMs: TIMEOUT_MS,
  })
  const result = await ses.send({ ...email, tags: email.tags ?? [] })
  if (result.ok) {
    logger.info({ messageId: result.messageId, tags: email.tags }, 'email sent')
    return { ok: true, messageId: result.messageId }
  }
  const fields = { status: result.status, code: result.code, tags: email.tags }
  if (result.attention) {
    logger.error({ ...fields, attention: result.attention }, SES_ATTENTION[result.attention])
  } else if (result.status === null) {
    logger.error({ ...fields, err: result.error }, 'email send failed')
  } else {
    logger.error(fields, 'email refused by SES')
  }
  return { ok: false, status: result.status ?? 503 }
}
