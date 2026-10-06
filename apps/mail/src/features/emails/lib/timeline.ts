import type { SendEvent } from '@dr/shared/mail'
import type { Tone } from '@/components/common/status-pill'
import type { EmailDetail, EmailEvent } from '../queries/log'
import { type BounceWords, bounceWords } from './bounce'
import { EVENT_WORDS, reasonWords } from './words'

/**
 * An email's life as a timeline (MAIL-SPEC §10 Email): when it was queued,
 * when it was due, every event Amazon SES reported, and when it was canceled
 * or given up — each a dated fact, oldest first.
 */

export type TimelineItem = {
  key: string
  at: string
  label: string
  detail: string | null
  tone: Tone
  bounce?: BounceWords
}

const EVENT_TONE: Record<SendEvent, Tone> = {
  send: 'info',
  delivery: 'success',
  bounce: 'danger',
  complaint: 'warning',
  reject: 'danger',
  delivery_delay: 'warning',
  rendering_failure: 'danger',
}

/** SES's own failures carry their event; any other failure is ours to date. */
const SES_FAILURES = new Set(['reject', 'rendering_failure'])

const time = (iso: string) => new Date(iso).getTime()

export function timeline(email: EmailDetail, events: EmailEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [
    {
      key: 'queued',
      at: email.created_at,
      label: 'Queued',
      detail: 'Your app’s request was accepted and the email waited for our sender.',
      tone: 'neutral',
    },
  ]
  if (time(email.scheduled_at) - time(email.created_at) > 1000) {
    items.push({
      key: 'scheduled',
      at: email.scheduled_at,
      label: 'Due',
      detail: 'The moment it was scheduled for: our sender takes it from here.',
      tone: 'neutral',
    })
  }
  for (const event of events) {
    const words = EVENT_WORDS[event.type]
    items.push({
      key: `event-${event.id}`,
      at: event.occurred_at,
      label: words.label,
      detail: words.detail,
      tone: EVENT_TONE[event.type],
      ...(event.type === 'bounce' ? { bounce: bounceWords(event.detail) } : {}),
    })
  }
  if (email.canceled_at) {
    items.push({
      key: 'canceled',
      at: email.canceled_at,
      label: 'Canceled',
      detail: 'Canceled before it was sent. Its recipients were given back to your caps.',
      tone: 'neutral',
    })
  }
  if (email.failed_at && !SES_FAILURES.has(email.status_reason ?? '')) {
    items.push({
      key: 'failed',
      at: email.failed_at,
      label: 'Not sent',
      detail: reasonWords(email.status_reason),
      tone: 'danger',
    })
  }
  return items.sort((a, b) => time(a.at) - time(b.at))
}

/** MR3: when the body goes — 72 hours after it left the queue; null while it waits. */
export function bodyKeptUntil(email: EmailDetail): string | null {
  const left = email.sent_at ?? email.failed_at ?? email.canceled_at
  return left ? new Date(time(left) + 72 * 60 * 60 * 1000).toISOString() : null
}
