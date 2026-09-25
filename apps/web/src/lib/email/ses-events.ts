import 'server-only'

import { createServiceClient } from '@/lib/supabase/service'

/**
 * Amazon SES delivery events (L1, FR-NT3), as the configuration set's event
 * destination publishes them to SNS. SES has no API to ask what became of a
 * message, so these pushed events are how a bounced ERRP notice becomes an
 * ops alert once EMAIL_PROVIDER=ses.
 *
 * Only what the database needs is kept: the message id, what happened, and
 * the event's type codes. Recipients, diagnostic text and headers — which
 * carry addresses and subjects — are never passed on or logged (N13).
 */

export type SesEventName =
  | 'delivery'
  | 'bounce'
  | 'complaint'
  | 'reject'
  | 'delivery_delay'
  | 'rendering_failure'

export type SesEvent = {
  messageId: string
  event: SesEventName
  /** Codes only — bounce and complaint types, the delay type, when it happened. */
  detail: Record<string, string>
}

const EVENT_NAMES: Record<string, SesEventName> = {
  Delivery: 'delivery',
  Bounce: 'bounce',
  Complaint: 'complaint',
  Reject: 'reject',
  DeliveryDelay: 'delivery_delay',
  'Rendering Failure': 'rendering_failure',
}

/** Where each event keeps its own record, and which of its codes we keep. */
const DETAIL: Record<SesEventName, { key: string; fields: Record<string, string> }> = {
  delivery: { key: 'delivery', fields: {} },
  bounce: {
    key: 'bounce',
    fields: { bounceType: 'bounce_type', bounceSubType: 'bounce_sub_type' },
  },
  complaint: {
    key: 'complaint',
    fields: { complaintFeedbackType: 'complaint_type', complaintSubType: 'complaint_sub_type' },
  },
  reject: { key: 'reject', fields: { reason: 'reason' } },
  delivery_delay: { key: 'deliveryDelay', fields: { delayType: 'delay_type' } },
  rendering_failure: { key: 'failure', fields: {} },
}

const MESSAGE_ID = /^[A-Za-z0-9._@<>+=-]{1,200}$/
/** A type code, not free text: letters, digits, spaces and a little punctuation. */
const CODE = /^[A-Za-z0-9 _.:-]{1,60}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/**
 * The SNS notification's `Message`, read as an SES event. Null for anything
 * that is not one of the six events the configuration set publishes — an
 * SNS test message, an open or click event — which is safely ignored.
 */
export function parseSesEvent(message: string): SesEvent | null {
  let json: unknown
  try {
    json = JSON.parse(message)
  } catch {
    return null
  }
  const record = asRecord(json)
  const type = record.eventType ?? record.notificationType
  const event = typeof type === 'string' ? EVENT_NAMES[type] : undefined
  if (!event) return null
  const messageId = asRecord(record.mail).messageId
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return null

  const { key, fields } = DETAIL[event]
  const source = asRecord(record[key])
  const detail: Record<string, string> = {}
  for (const [from, to] of Object.entries(fields)) {
    const value = source[from]
    if (typeof value === 'string' && CODE.test(value)) detail[to] = value
  }
  const at = source.timestamp ?? asRecord(record.mail).timestamp
  if (typeof at === 'string' && TIMESTAMP.test(at)) detail.at = at
  return { messageId, event, detail }
}

/**
 * Records one event (migration 34, `record_email_event`): idempotent, so a
 * repeated SNS delivery changes nothing. Resolves to whether the message is
 * one of ours; throws when the database could not be asked, so SNS retries.
 */
export async function recordSesEvent(event: SesEvent): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('record_email_event', {
    p_message_id: event.messageId,
    p_event: event.event,
    p_detail: event.detail,
  })
  if (error) throw new Error(error.message)
  return data === true
}
