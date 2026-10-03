import { NOT_SENT_AGAIN, UNCONFIRMED_HOURS } from '@/features/admin/lib/emails-copy'

/**
 * When "Send again" is offered (docs/ADMIN-SPEC.md §5.2, B11): for a failed
 * email only, never one that bounced or that its recipient reported as spam,
 * and only to a role that may (`email.requeue`, operator). It mirrors
 * `admin_requeue_email`'s guards (NOT_FAILED, BOUNCED, COMPLAINED) so the
 * page offers nothing SQL would refuse on its face; SQL decides again, and
 * also holds a test admin to an e2e account's test email (D15).
 */

export type RequeueFacts = {
  status: string
  deliveryStatus: string | null
  complainedAt: string | null
}

export type SendAgainOffer = { offer: true } | { offer: false; why: string | null }

export function sendAgainOffer(email: RequeueFacts, mayRequeue: boolean): SendAgainOffer {
  if (email.status !== 'failed') return { offer: false, why: null }
  if (email.complainedAt) return { offer: false, why: NOT_SENT_AGAIN.complained }
  if (email.deliveryStatus === 'bounced') return { offer: false, why: NOT_SENT_AGAIN.bounced }
  if (!mayRequeue) return { offer: false, why: NOT_SENT_AGAIN.role }
  return { offer: true }
}

export type DeliveryFacts = {
  status: string
  category: string
  deliveryStatus: string | null
  sentAt: string | null
}

/**
 * A security or compliance email sent over a day ago with no final report
 * (`email_unconfirmed`, CLAUDE.md §15): it is not counted as delivered just
 * because nothing bounced. Transactional email is not read back, so it has
 * no report to miss.
 */
export function isUnconfirmed(email: DeliveryFacts, now: Date): boolean {
  if (email.status !== 'sent') return false
  if (email.category !== 'security' && email.category !== 'compliance') return false
  if (email.deliveryStatus !== null && email.deliveryStatus !== 'deferred') return false
  const sent = email.sentAt ? Date.parse(email.sentAt) : Number.NaN
  return !Number.isNaN(sent) && now.getTime() - sent > UNCONFIRMED_HOURS * 3_600_000
}
