import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  errpNoticeDue,
  expiryUrgency,
  isTransferEligible,
  transferEligibleAt,
} from './index'

describe('domain state machine', () => {
  it('allows a pending domain to become active', () => {
    expect(canTransition('pending', 'active')).toBe(true)
  })

  it('refuses to resurrect a released domain', () => {
    expect(canTransition('released', 'active')).toBe(false)
  })

  it('refuses to skip redemption on the way to deletion', () => {
    expect(canTransition('expired_grace', 'pending_delete')).toBe(false)
  })

  it('allows recovery from redemption back to active (a restore)', () => {
    expect(canTransition('redemption', 'active')).toBe(true)
  })

  it('follows a transfer in to active, and never lets a rejected one become active', () => {
    expect(canTransition('transfer_requested', 'transfer_pending')).toBe(true)
    expect(canTransition('transfer_pending', 'active')).toBe(true)
    // Found already ours by the first read: an earlier attempt landed (I1).
    expect(canTransition('transfer_requested', 'active')).toBe(true)
    expect(canTransition('transfer_rejected', 'active')).toBe(false)
    expect(canTransition('transfer_cancelled', 'active')).toBe(false)
  })

  it('throws on an illegal transition rather than silently allowing it', () => {
    expect(() => assertTransition('active', 'released')).toThrow(/Illegal domain transition/)
  })
})

describe('expiryUrgency', () => {
  it.each([
    [90, 'safe'],
    [31, 'safe'],
    [30, 'soon'],
    [8, 'soon'],
    [7, 'urgent'],
    [4, 'urgent'],
    [3, 'critical'],
    [0, 'critical'],
    [-1, 'expired'],
  ])('bands %i days as %s', (days, expected) => {
    expect(expiryUrgency(days)).toBe(expected)
  })
})

describe('60-day transfer lock', () => {
  const registered = new Date('2026-01-01T00:00:00Z')

  it('computes the eligibility date 60 days out', () => {
    expect(transferEligibleAt(registered).toISOString()).toBe('2026-03-02T00:00:00.000Z')
  })

  it('blocks a transfer on day 59', () => {
    expect(isTransferEligible(registered, new Date('2026-02-28T00:00:00Z'))).toBe(false)
  })

  it('permits a transfer on day 60', () => {
    expect(isTransferEligible(registered, new Date('2026-03-02T00:00:00Z'))).toBe(true)
  })
})

describe('ERRP notice windows', () => {
  it('fires the first notice inside the 26–35 day window', () => {
    expect(errpNoticeDue(30)).toBe('errp_pre_35')
    expect(errpNoticeDue(35)).toBe('errp_pre_35')
    expect(errpNoticeDue(26)).toBe('errp_pre_35')
  })

  it('fires the second notice inside the 4–10 day window', () => {
    expect(errpNoticeDue(7)).toBe('errp_pre_7')
  })

  it('fires nothing in the gap between the two windows', () => {
    expect(errpNoticeDue(20)).toBeNull()
  })

  it('fires the post-expiry notice within 5 days of expiry', () => {
    expect(errpNoticeDue(-3)).toBe('errp_post')
    expect(errpNoticeDue(-6)).toBeNull()
  })
})
