import { describe, expect, it } from 'vitest'
import {
  EMAIL_STATUSES,
  type EmailStatus,
  isFinal,
  isPending,
  nextStatus,
  SEND_EVENTS,
  type SendEvent,
  statusForEvent,
} from './status'

/** Events in order, from a queued email: the status after each. */
function play(events: SendEvent[], from: EmailStatus = 'sending'): EmailStatus {
  return events.reduce(nextStatus, from)
}

describe('status precedence (§6, the shop’s rule) — the same table as mail.record_send_event', () => {
  it('sent, then delivered', () => {
    expect(play(['send', 'delivery'])).toBe('delivered')
  })

  it('a late bounce wins over a delivery', () => {
    expect(play(['send', 'delivery', 'bounce'])).toBe('bounced')
  })

  it('a delivery never undoes a bounce, whatever the order', () => {
    expect(play(['bounce', 'delivery'])).toBe('bounced')
    expect(play(['delivery', 'send'])).toBe('delivered')
  })

  it('a complaint is recorded over a delivery, but is not a bounce and never undoes one', () => {
    expect(play(['delivery', 'complaint'])).toBe('complained')
    expect(play(['bounce', 'complaint'])).toBe('bounced')
    expect(play(['complaint', 'bounce'])).toBe('bounced')
  })

  it('a delay is an event, not a status', () => {
    expect(play(['send', 'delivery_delay'])).toBe('sent')
    expect(statusForEvent('delivery_delay')).toBeNull()
  })

  it('a rejection or a rendering failure is a failure', () => {
    expect(play(['send', 'reject'])).toBe('failed')
    expect(play(['rendering_failure'], 'sent')).toBe('failed')
    expect(play(['delivery'], 'failed')).toBe('failed')
  })

  it('the same event twice changes nothing', () => {
    for (const event of SEND_EVENTS) {
      const once = play([event])
      expect(nextStatus(once, event)).toBe(once)
    }
  })

  it('knows which statuses can still change by our hand, and which are done', () => {
    expect(EMAIL_STATUSES.filter(isPending)).toEqual(['queued'])
    expect(EMAIL_STATUSES.filter(isFinal)).toEqual(['bounced', 'failed', 'suppressed', 'canceled'])
  })
})
