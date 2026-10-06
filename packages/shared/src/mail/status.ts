/**
 * An email's life (MAIL-SPEC §6): queued → sending → sent → delivered, or
 * bounced / complained / failed / suppressed / canceled; a delivery delay is
 * an event, not a status. When SES's events arrive out of order the shop's
 * rule applies (migration 34): bounced beats delivered beats deferred, a late
 * bounce wins, and a complaint is recorded but is not a bounce. SQL decides
 * (`mail.record_send_event`, migration 44); this mirror is for the dashboard
 * and the event endpoint, and its tests pin the same table.
 */

export const EMAIL_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
  'canceled',
] as const

export type EmailStatus = (typeof EMAIL_STATUSES)[number]

export const SEND_EVENTS = [
  'send',
  'delivery',
  'bounce',
  'complaint',
  'reject',
  'delivery_delay',
  'rendering_failure',
] as const

export type SendEvent = (typeof SEND_EVENTS)[number]

/** The status an event points to; a delay points nowhere. */
export function statusForEvent(event: SendEvent): EmailStatus | null {
  switch (event) {
    case 'send':
      return 'sent'
    case 'delivery':
      return 'delivered'
    case 'complaint':
      return 'complained'
    case 'bounce':
      return 'bounced'
    case 'reject':
    case 'rendering_failure':
      return 'failed'
    case 'delivery_delay':
      return null
  }
}

/** Higher wins. Queued, sending, suppressed and canceled hold no rank: any event outranks them. */
export function statusRank(status: EmailStatus): number {
  switch (status) {
    case 'sent':
      return 1
    case 'delivered':
      return 2
    case 'complained':
      return 3
    case 'bounced':
    case 'failed':
      return 4
    default:
      return 0
  }
}

/** The status after an event: never backwards, so a repeated or late event changes nothing it should not. */
export function nextStatus(current: EmailStatus, event: SendEvent): EmailStatus {
  const seen = statusForEvent(event)
  if (seen === null) return current
  return statusRank(seen) > statusRank(current) ? seen : current
}

/** Whether an email can still change by our hand (cancel, reschedule): only before it leaves. */
export const isPending = (status: EmailStatus): boolean => status === 'queued'

/** Whether nothing more will happen to it but late events. */
export const isFinal = (status: EmailStatus): boolean =>
  status === 'bounced' || status === 'failed' || status === 'suppressed' || status === 'canceled'
