import type { EmailStatus } from '@dr/shared/mail'

/**
 * Each status in a sentence (MAIL-SPEC §6), for the statuses page. What
 * moves an email between them is SQL's (migrations 44 and 48); a test holds
 * this list to every status there is.
 */
export const STATUS_DOCS: Record<EmailStatus, string> = {
  queued:
    'Accepted and waiting for our sender — now, or at its scheduled_at. It can still be rescheduled or canceled.',
  sending: 'Our sender has taken it and is handing it to Amazon SES.',
  sent: 'Amazon SES accepted it for delivery.',
  delivered: 'The recipient’s mail server accepted it.',
  bounced: 'The recipient’s mail server turned it away. The email page says why, in plain words.',
  complained: 'Delivered, then the recipient reported it as spam.',
  failed:
    'It was not sent, or Amazon SES refused it: status_reason says why (for example key_revoked, domain_not_verified, reject).',
  suppressed:
    'Not sent, because a recipient is on this account’s suppression list. It counts nothing against your caps.',
  canceled: 'Canceled before it was sent, through the API.',
}
