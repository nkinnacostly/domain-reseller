/**
 * A bounce in plain words (MAIL-SPEC §10: "the bounce reason in plain
 * words"), from the type and subtype Amazon SES reports (its "Bounce types"
 * table) and, when it came, what the receiving server said — kept by SQL
 * with every address struck out (MR4, `sanitise_detail`).
 */

export type BounceDetail = Record<string, unknown>

const WORDS: Record<string, string> = {
  'Permanent/General':
    'The receiving server said this address does not exist or will not take email from you. Sending to it again will bounce again.',
  'Permanent/NoEmail': 'This address does not exist. Sending to it again will bounce again.',
  'Permanent/Suppressed':
    'Amazon SES did not send it: this address bounced hard recently, so Amazon keeps it on its suppression list.',
  'Permanent/OnAccountSuppressionList':
    'Amazon SES did not send it: this address is on a suppression list for your account.',
  'Transient/General':
    'The receiving server turned it away for now. It may accept a later email; if it keeps happening, check the address.',
  'Transient/MailboxFull': 'The recipient’s mailbox is full.',
  'Transient/MessageTooLarge': 'The email is larger than the receiving server takes.',
  'Transient/ContentRejected': 'The receiving server refused what the email contains.',
  'Transient/AttachmentRejected': 'The receiving server refused an attachment.',
}

const BY_TYPE: Record<string, string> = {
  Permanent:
    'The receiving server turned it away for good. Sending to this address again will bounce again.',
  Transient: 'The receiving server turned it away for now. It may accept a later email.',
  Undetermined: 'The receiving server turned it away, without saying why in a way we can read.',
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

export type BounceWords = { summary: string; serverSaid: string | null; kind: string | null }

export function bounceWords(detail: BounceDetail): BounceWords {
  const type = text(detail.bounceType)
  const subtype = text(detail.bounceSubType)
  const summary =
    (type && subtype && WORDS[`${type}/${subtype}`]) ||
    (type && BY_TYPE[type]) ||
    'The receiving server turned it away.'
  return {
    summary,
    serverSaid: text(detail.diagnosticCode) ?? text(detail.smtpResponse),
    kind: type ? [type, subtype].filter(Boolean).join(' / ') : null,
  }
}
