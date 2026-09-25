import { LOCAL_STATUS } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import {
  describeHold,
  hasFreshSecondFactor,
  NOT_HELD_STATUSES,
  purchaseNeedsTwoFactor,
  RESET_HOLD_HOURS,
  resetHoldUntil,
  SENSITIVE_CHANGE_NEEDS_TWO_FACTOR,
  startedFromEmailLink,
  startedWithStrongSignIn,
  TWO_FACTOR_REQUIRED_ABOVE_DOMAINS,
  TWO_FACTOR_SETTINGS_HREF,
  twoFactorRequired,
} from '../lib/security'

const NOW = new Date('2026-09-22T12:00:00Z')
const seconds = (date: Date) => Math.floor(date.getTime() / 1000)

describe('resetHoldUntil (FR-A6)', () => {
  it('holds sensitive changes for 24 hours after a reset', () => {
    const until = resetHoldUntil('2026-09-22T09:00:00Z', NOW)
    expect(until?.toISOString()).toBe('2026-09-23T09:00:00.000Z')
  })

  it('lifts the hold once 24 hours have passed', () => {
    const exactly = new Date(NOW.getTime() - RESET_HOLD_HOURS * 3_600_000).toISOString()
    expect(resetHoldUntil(exactly, NOW)).toBeNull()
  })

  it('has no hold without a reset', () => {
    expect(resetHoldUntil(null, NOW)).toBeNull()
  })

  it('names the time the hold ends, in Lagos time', () => {
    expect(describeHold(new Date('2026-09-23T09:00:00Z'))).toContain('Wednesday 10:00')
  })
})

describe('how the session started', () => {
  const password = { method: 'password', timestamp: seconds(NOW) }
  const emailLink = { method: 'otp', timestamp: seconds(NOW) }
  const totp = { method: 'totp', timestamp: seconds(NOW) }

  it('treats a reset or magic-link session as an email-link session', () => {
    expect(startedFromEmailLink([emailLink])).toBe(true)
    expect(startedWithStrongSignIn([emailLink])).toBe(false)
  })

  it('treats a password session as one, second factor or not', () => {
    expect(startedWithStrongSignIn([totp, password])).toBe(true)
    expect(startedFromEmailLink([totp, password])).toBe(false)
  })

  it('reads the plain-string form some tokens use', () => {
    expect(startedWithStrongSignIn(['password'])).toBe(true)
    expect(startedFromEmailLink(['otp'])).toBe(true)
  })

  it('treats a Google sign-in like the password — only the account holder has it (FR-A1)', () => {
    const google = { method: 'oauth', timestamp: seconds(NOW) }
    expect(startedWithStrongSignIn([google])).toBe(true)
    expect(startedFromEmailLink([google])).toBe(false)
    expect(startedFromEmailLink(['otp', 'oauth'])).toBe(false)
  })
})

describe('hasFreshSecondFactor (FR-A3)', () => {
  it('accepts a code verified within 15 minutes', () => {
    const at = seconds(NOW) - 14 * 60
    expect(hasFreshSecondFactor([{ method: 'totp', timestamp: at }], NOW)).toBe(true)
  })

  it('asks again once 15 minutes have passed', () => {
    const at = seconds(NOW) - 16 * 60
    expect(hasFreshSecondFactor([{ method: 'totp', timestamp: at }], NOW)).toBe(false)
  })

  it('does not count a password as a second factor', () => {
    expect(hasFreshSecondFactor([{ method: 'password', timestamp: seconds(NOW) }], NOW)).toBe(false)
  })
})

describe('mandatory two-factor (FR-A2)', () => {
  it('is required above ten domains, not at ten', () => {
    expect(TWO_FACTOR_REQUIRED_ABOVE_DOMAINS).toBe(10)
    expect(twoFactorRequired(0)).toBe(false)
    expect(twoFactorRequired(10)).toBe(false)
    expect(twoFactorRequired(11)).toBe(true)
    expect(twoFactorRequired(250)).toBe(true)
  })

  it('stops counting a domain that is not the account’s: gone, moved away, never registered, a transfer in refused or cancelled, or closed', () => {
    expect([...NOT_HELD_STATUSES].sort()).toEqual(
      [
        'closed',
        'registration_failed',
        'released',
        'transfer_cancelled',
        'transfer_rejected',
        'transferred_away',
      ].sort(),
    )
    for (const status of NOT_HELD_STATUSES) expect(LOCAL_STATUS).toContain(status)
  })

  it('keeps counting a domain that is registering, expiring, in redemption or moving in', () => {
    for (const status of ['pending', 'active', 'expired_grace', 'redemption', 'transfer_pending']) {
      expect(NOT_HELD_STATUSES).not.toContain(status)
    }
  })

  it('says why an order is refused, that nothing was charged, and where to turn it on', () => {
    expect(purchaseNeedsTwoFactor('order', 'Nothing was charged.')).toBe(
      'Accounts holding more than 10 domains need two-factor authentication before ordering more domains. Nothing was charged. Turn it on in Settings, under Two-factor authentication, then try again.',
    )
    expect(purchaseNeedsTwoFactor('transfer', 'Nothing was charged.')).toMatch(
      /before transferring more domains in\. Nothing was charged\./,
    )
  })

  it('never asks an account with no authenticator for a code', () => {
    expect(SENSITIVE_CHANGE_NEEDS_TWO_FACTOR).not.toMatch(/code/)
    expect(SENSITIVE_CHANGE_NEEDS_TWO_FACTOR).toMatch(/Turn it on in Settings/)
    expect(TWO_FACTOR_SETTINGS_HREF).toBe('/app/settings#two-factor')
  })
})
