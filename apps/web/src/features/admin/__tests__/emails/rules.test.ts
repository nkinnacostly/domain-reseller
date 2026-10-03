import { describe, expect, it } from 'vitest'
import { isUnconfirmed, sendAgainOffer } from '@/features/admin/lib/emails-rules'
import {
  type KindStat,
  kindRows,
  noticeTotals,
  outboxTotals,
} from '@/features/admin/lib/emails-stats'

/**
 * When "Send again" is offered, when a sent email has gone without a report
 * too long, and the figures (ADMIN-SPEC §5.2 B11). The refusals first: a
 * bounce or a spam report is never sent again, whatever the role.
 */

const failed = { status: 'failed', deliveryStatus: null, complainedAt: null }

describe('sendAgainOffer', () => {
  it('never offers an email that bounced or was reported as spam, even to the owner', () => {
    expect(sendAgainOffer({ ...failed, deliveryStatus: 'bounced' }, true)).toEqual({
      offer: false,
      why: 'Bounced: never sent again.',
    })
    expect(sendAgainOffer({ ...failed, complainedAt: '2026-10-03T09:00:00Z' }, true)).toEqual({
      offer: false,
      why: 'Reported as spam: never sent again.',
    })
    // A sent email that bounced has nothing to send again, and says nothing.
    expect(sendAgainOffer({ ...failed, status: 'sent', deliveryStatus: 'bounced' }, true)).toEqual({
      offer: false,
      why: null,
    })
  })

  it('offers only a failed email', () => {
    for (const status of ['pending', 'sending', 'sent', 'skipped']) {
      expect(sendAgainOffer({ ...failed, status }, true), status).toEqual({
        offer: false,
        why: null,
      })
    }
    expect(sendAgainOffer(failed, true)).toEqual({ offer: true })
    // A deferred report is not a bounce.
    expect(sendAgainOffer({ ...failed, deliveryStatus: 'deferred' }, true)).toEqual({
      offer: true,
    })
  })

  it('tells a role that may not why there is no button', () => {
    expect(sendAgainOffer(failed, false)).toEqual({
      offer: false,
      why: 'An operator or the owner can send it again.',
    })
  })
})

describe('isUnconfirmed', () => {
  const now = new Date('2026-10-03T12:00:00Z')
  const sent = {
    status: 'sent',
    category: 'security',
    deliveryStatus: null,
    sentAt: '2026-10-02T11:00:00Z',
  }

  it('flags a security or compliance email sent over a day ago with no final report', () => {
    expect(isUnconfirmed(sent, now)).toBe(true)
    expect(
      isUnconfirmed({ ...sent, category: 'compliance', deliveryStatus: 'deferred' }, now),
    ).toBe(true)
  })

  it('does not flag one reported, one under a day old, a transactional one or one not sent', () => {
    expect(isUnconfirmed({ ...sent, deliveryStatus: 'delivered' }, now)).toBe(false)
    expect(isUnconfirmed({ ...sent, deliveryStatus: 'bounced' }, now)).toBe(false)
    expect(isUnconfirmed({ ...sent, sentAt: '2026-10-02T12:30:00Z' }, now)).toBe(false)
    expect(isUnconfirmed({ ...sent, category: 'transactional' }, now)).toBe(false)
    expect(isUnconfirmed({ ...sent, status: 'failed' }, now)).toBe(false)
    expect(isUnconfirmed({ ...sent, sentAt: null }, now)).toBe(false)
    expect(isUnconfirmed({ ...sent, sentAt: 'not a date' }, now)).toBe(false)
  })
})

const stat = (overrides: Partial<KindStat>): KindStat => ({
  kind: 'order_receipt',
  category: 'transactional',
  status: 'sent',
  deliveryStatus: null,
  count: 1,
  ...overrides,
})

describe('figures', () => {
  const rows = [
    stat({ count: 4 }),
    stat({ deliveryStatus: 'delivered', count: 2 }),
    stat({ deliveryStatus: 'bounced', count: 1 }),
    stat({ status: 'failed', count: 3 }),
    stat({ kind: 'new_sign_in', category: 'security', status: 'pending', count: 2 }),
    stat({ kind: 'new_sign_in', category: 'security', status: 'sending', count: 1 }),
    stat({ kind: 'two_factor_on', category: 'security', status: 'skipped', count: 5 }),
  ]

  it('adds up the outbox: delivered and bounced are part of sent', () => {
    expect(outboxTotals(rows)).toEqual({
      total: 18,
      failed: 3,
      waiting: 3,
      sent: 7,
      delivered: 2,
      bounced: 1,
      skipped: 5,
    })
    expect(outboxTotals([])).toMatchObject({ total: 0, failed: 0 })
  })

  it('gives one row per kind, the busiest first, ties by name', () => {
    expect(kindRows(rows).map((row) => [row.kind, row.category, row.total])).toEqual([
      ['order_receipt', 'transactional', 10],
      ['two_factor_on', 'security', 5],
      ['new_sign_in', 'security', 3],
    ])
    expect(kindRows([stat({ kind: 'b' }), stat({ kind: 'a' })]).map((row) => row.kind)).toEqual([
      'a',
      'b',
    ])
  })

  it('counts every notice type by delivery, in the order they are sent', () => {
    expect(
      noticeTotals([
        { noticeType: 'errp_pre_7', deliveryStatus: 'bounced', count: 1 },
        { noticeType: 'errp_pre_7', deliveryStatus: 'delivered', count: 4 },
        { noticeType: 'errp_pre_7', deliveryStatus: 'sent', count: 2 },
        { noticeType: 'unknown', deliveryStatus: 'sent', count: 9 },
      ]),
    ).toEqual([
      { type: 'errp_pre_35', total: 0, unreported: 0, delivered: 0, bounced: 0 },
      { type: 'errp_pre_7', total: 7, unreported: 2, delivered: 4, bounced: 1 },
      { type: 'errp_post', total: 0, unreported: 0, delivered: 0, bounced: 0 },
    ])
  })
})
