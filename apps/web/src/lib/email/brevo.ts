import 'server-only'

import { BUSINESS } from '@/lib/business'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Sends one email through Brevo's transactional API (L1). Every message comes
 * from the no-reply address on the authenticated subdomain and sets Reply-To
 * to the support inbox, so a customer who answers reaches a person.
 *
 * Addresses and content never reach a log line (N13) — only the outcome and
 * Brevo's message id.
 */

export type OutgoingEmail = {
  to: string
  subject: string
  html: string
  text: string
  /** Brevo tags, for its delivery log: what kind of email this was. */
  tags?: string[]
}

export type SendResult = { ok: true; messageId: string | null } | { ok: false; status: number }

export const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email'
const TIMEOUT_MS = 10_000

export async function sendEmail(email: OutgoingEmail): Promise<SendResult> {
  const apiKey = env.BREVO_API_KEY
  if (!apiKey) {
    logger.error('BREVO_API_KEY is not set: email not sent')
    return { ok: false, status: 500 }
  }
  let response: Response
  try {
    response = await fetch(BREVO_SEND_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: BUSINESS.brand, email: BUSINESS.noReplyEmail },
        replyTo: { name: BUSINESS.brand, email: BUSINESS.email },
        to: [{ email: email.to }],
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
        ...(email.tags?.length ? { tags: email.tags } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : 'error', tags: email.tags },
      'email send failed',
    )
    return { ok: false, status: 503 }
  }
  if (!response.ok) {
    logger.error({ status: response.status, tags: email.tags }, 'email refused by Brevo')
    return { ok: false, status: response.status }
  }
  const body = (await response.json().catch(() => ({}))) as { messageId?: unknown }
  const messageId = typeof body.messageId === 'string' ? body.messageId : null
  logger.info({ messageId, tags: email.tags }, 'email sent')
  return { ok: true, messageId }
}
