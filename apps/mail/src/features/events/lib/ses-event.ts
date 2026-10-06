import type { SendEvent } from '@dr/shared/mail'

/**
 * One SES sending event, as each account's configuration set publishes it to
 * SNS `mail-ses-events` (MAIL-SPEC §4.1.2, §4.2), read into what
 * `mail.record_send_event` (migration 49) takes.
 *
 * The email is found by SES's message id, or — when the event beats the
 * worker's record of the send — by the `mdm_email` tag our SendEmail sets
 * (packages/shared/src/ses/tenant-send.ts). Only codes and words reach the
 * detail, which SQL strikes every address from again; the addresses SES
 * names for a permanent bounce or a complaint go to the suppression list
 * and nowhere else — never a log line (N13, MR4).
 */

export type MailSendEvent = {
  event: SendEvent
  messageId: string
  /** The email's public id, from our `mdm_email` tag. */
  emailId: string | null
  /** When it happened, as SES says (ISO 8601). */
  occurredAt: string | null
  /** The keys `mail.sanitise_detail` keeps. */
  detail: Record<string, string>
  /** How many recipients it concerns: usage counts recipients, as SES does. */
  recipients: number
  /** The addresses to suppress, as SES names them (case kept). */
  suppress: string[]
}

const EVENTS: Record<string, SendEvent> = {
  Send: 'send',
  Delivery: 'delivery',
  Bounce: 'bounce',
  Complaint: 'complaint',
  Reject: 'reject',
  DeliveryDelay: 'delivery_delay',
  'Rendering Failure': 'rendering_failure',
}

/** Where each event keeps its own record, and its list of recipients. */
const RECORD: Record<SendEvent, { key: string; recipients: string | null }> = {
  send: { key: 'send', recipients: null },
  delivery: { key: 'delivery', recipients: 'recipients' },
  bounce: { key: 'bounce', recipients: 'bouncedRecipients' },
  complaint: { key: 'complaint', recipients: 'complainedRecipients' },
  reject: { key: 'reject', recipients: null },
  delivery_delay: { key: 'deliveryDelay', recipients: 'delayedRecipients' },
  rendering_failure: { key: 'failure', recipients: null },
}

const MESSAGE_ID = /^[A-Za-z0-9._@<>+=-]{1,200}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const ADDRESS = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown, max = 500): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null

/**
 * The SNS notification's `Message`, already parsed, as a Mail send event —
 * or null when it is none of the seven the configuration set publishes (an
 * SNS test message, an open or a click), which is safely ignored.
 */
export function parseSendEvent(json: Record<string, unknown>): MailSendEvent | null {
  const type = json.eventType ?? json.notificationType
  const event = typeof type === 'string' ? EVENTS[type] : undefined
  if (!event) return null
  const mail = asRecord(json.mail)
  const messageId = mail.messageId
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return null
  const tag = asArray(asRecord(mail.tags).mdm_email)[0]
  const emailId = typeof tag === 'string' && UUID.test(tag) ? tag.toLowerCase() : null

  const { key, recipients: listKey } = RECORD[event]
  const record = asRecord(json[key])
  const list = listKey ? asArray(record[listKey]) : []
  const first = asRecord(list[0])
  const candidates: Record<string, unknown> = {
    bounceType: record.bounceType,
    bounceSubType: record.bounceSubType,
    complaintFeedbackType: record.complaintFeedbackType,
    complaintSubType: record.complaintSubType,
    delayType: record.delayType,
    rejectReason: event === 'reject' ? record.reason : undefined,
    errorMessage: record.errorMessage,
    smtpResponse: record.smtpResponse,
    diagnosticCode: first.diagnosticCode,
    status: first.status,
    action: first.action,
  }
  const detail: Record<string, string> = {}
  for (const [name, value] of Object.entries(candidates)) {
    const kept = text(value)
    if (kept) detail[name] = kept
  }

  const at = text(record.timestamp, 40) ?? text(mail.timestamp, 40)
  const suppressible =
    event === 'complaint' || (event === 'bounce' && record.bounceType === 'Permanent')
  const suppress = suppressible
    ? list
        .map((entry) => asRecord(entry).emailAddress)
        .filter(
          (address): address is string => typeof address === 'string' && ADDRESS.test(address),
        )
        .slice(0, 50)
    : []

  return {
    event,
    messageId,
    emailId,
    occurredAt: at && TIMESTAMP.test(at) ? at : null,
    detail,
    recipients: Math.min(Math.max(list.length, 1), 50),
    suppress,
  }
}
