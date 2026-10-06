import type { EmailStatus, SendEvent } from '@dr/shared/mail'

/**
 * What happened to an email, in plain words, for the log and the email page
 * (MAIL-SPEC §6, §10). Events are Amazon SES's (§4.2); a status reason is the
 * short code SQL records when an email fails, is suppressed or is canceled
 * (migrations 44 and 48). A code we have no words for is shown as itself,
 * never hidden.
 */

export const EVENT_WORDS: Record<SendEvent, { label: string; detail: string }> = {
  send: { label: 'Sent', detail: 'Amazon SES accepted it for delivery.' },
  delivery: { label: 'Delivered', detail: 'The recipient’s mail server accepted it.' },
  bounce: { label: 'Bounced', detail: 'The recipient’s mail server turned it away.' },
  complaint: {
    label: 'Marked as spam',
    detail: 'The recipient reported it as spam to their mail provider.',
  },
  reject: { label: 'Rejected', detail: 'Amazon SES refused to send it.' },
  delivery_delay: {
    label: 'Delayed',
    detail: 'The recipient’s server has not accepted it yet; Amazon SES keeps trying.',
  },
  rendering_failure: { label: 'Not built', detail: 'Amazon SES could not build the message.' },
}

const REASON_WORDS: Record<string, string> = {
  canceled: 'It was canceled before it was sent.',
  suppressed:
    'A recipient is on this account’s suppression list, so it was not sent. Nothing was counted against your caps.',
  key_revoked: 'The API key that queued it was revoked before it was sent, so it was not sent.',
  domain_not_verified: 'Its domain stopped being verified before it was sent, so it was not sent.',
  account_paused: 'Sending was paused on this account before it was sent, so it was not sent.',
  payload_missing: 'Its body was missing when it was due, so it was not sent.',
  retries_exhausted:
    'Amazon SES could not take it after repeated tries, so we stopped. It was not sent.',
  worker_lost:
    'Our sender stopped while sending it, on its last try. It may or may not have gone out.',
  reject: 'Amazon SES rejected it.',
  rendering_failure: 'Amazon SES could not build the message.',
  messagerejected: 'Amazon SES refused this message.',
  mailfromdomainnotverifiedexception:
    'Amazon SES refused it: the sending domain is not verified there.',
  unreadable_claim: 'Our sender could not read it when it was due, so it was not sent.',
}

/** Why an email failed, was suppressed or canceled; null when there is no reason to give. */
export function reasonWords(reason: string | null): string | null {
  if (!reason) return null
  return REASON_WORDS[reason] ?? `It was not sent (code: ${reason}).`
}

/** Whether it waits for a moment later than when it was queued (§3.1). */
export function isScheduled(email: {
  status: EmailStatus
  created_at: string
  scheduled_at: string
}): boolean {
  return (
    email.status === 'queued' &&
    new Date(email.scheduled_at).getTime() - new Date(email.created_at).getTime() > 1000
  )
}
