import { refusalToApiError, type SqlRefusal } from '@dr/shared/mail'
import { SMTP_LIMITS } from './message'

/**
 * What the relay answers, in SMTP's terms (RFC 5321, enhanced codes RFC
 * 3463), with the v1 API's own words wherever SQL refused — one wording for
 * both ways in. A 4xx is "try again later": a client with a queue (Postfix,
 * a WordPress plugin that retries) waits and sends again. A 5xx is final:
 * someone must change something. The text never quotes an address, a
 * subject or a key (N13).
 */

export type SmtpReply = { code: number; text: string }

const mb = (bytes: number) => Math.floor(bytes / (1024 * 1024))

/** One line, at most 400 characters: SMTP replies are lines of 512 at most. */
const line = (text: string) => text.replace(/[\r\n]+/g, ' ').slice(0, 400)

export const REPLIES = {
  authFailed: {
    code: 535,
    text: '5.7.8 Authentication failed: the password must be a live MyDomainsHub Mail API key (mdh_live_…).',
  },
  authUnavailable: {
    code: 454,
    text: '4.7.0 We could not check the key just now. Try again in a minute.',
  },
  tooManyRecipients: {
    code: 452,
    text: `4.5.3 Too many recipients: at most ${SMTP_LIMITS.maxRecipients} for one email, across To, Cc and Bcc. Send the rest as another email.`,
  },
  badRecipient: { code: 553, text: '5.1.3 That recipient is not an email address.' },
  tooManyMessages: {
    code: 451,
    text: `4.7.1 That is ${SMTP_LIMITS.maxMessagesPerConnection} emails on this connection. Reconnect to send more.`,
  },
  tooBig: {
    code: 552,
    text: `5.3.4 The message is larger than ${mb(SMTP_LIMITS.maxMessageBytes)} MB. Send smaller attachments.`,
  },
  unreadable: { code: 550, text: '5.6.0 The message could not be read as MIME.' },
  noFrom: { code: 550, text: '5.6.0 The message has no From address.' },
  noTo: {
    code: 550,
    text: '5.6.0 At least one recipient must be in the To header as well as in RCPT TO.',
  },
  internal: {
    code: 451,
    text: '4.3.0 Something went wrong on our side. Try again in a moment.',
  },
} as const satisfies Record<string, SmtpReply>

/** The message's own problem, found by the API's schema or content checks. */
export const invalidReply = (message: string): SmtpReply => ({
  code: 550,
  text: line(`5.6.0 ${message}`),
})

/** SQL's refusal (authenticate_key, enqueue_email) as SMTP. */
export function refusalReply(refusal: SqlRefusal): SmtpReply {
  const words = refusalToApiError(refusal).message
  switch (refusal.code) {
    case 'unauthorized':
      return REPLIES.authFailed
    case 'rate_limited':
    case 'budget_exceeded':
      return { code: 451, text: line(`4.7.1 ${words}`) }
    case 'account_not_ready':
      return { code: 451, text: line(`4.3.0 ${words}`) }
    case 'quota_exceeded':
      // Today's cap opens at midnight: a queue should wait. The month's is final for now.
      return refusal.scope === 'month'
        ? { code: 550, text: line(`5.7.1 ${words}`) }
        : { code: 451, text: line(`4.7.1 ${words}`) }
    case 'forbidden':
    case 'sandbox_recipient':
    case 'domain_not_verified':
    case 'account_paused':
    case 'account_closed':
      return { code: 550, text: line(`5.7.1 ${words}`) }
    case 'validation':
    case 'idempotency_conflict':
    case 'not_found':
      return invalidReply(words)
    default:
      return REPLIES.internal
  }
}

/** What the success line says: the id the API and the dashboard know it by. */
export const queuedText = (id: string) => `2.0.0 Queued as ${id}`

/** An SMTP reply as smtp-server takes it from a callback. */
export function replyError({ code, text }: SmtpReply): Error & { responseCode: number } {
  return Object.assign(new Error(text), { responseCode: code })
}
