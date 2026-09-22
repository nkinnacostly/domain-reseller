import { describe, expect, it } from 'vitest'
import {
  describeHold,
  hasFreshSecondFactor,
  RESET_HOLD_HOURS,
  resetHoldUntil,
  startedFromEmailLink,
  startedWithPassword,
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
    expect(startedWithPassword([emailLink])).toBe(false)
  })

  it('treats a password session as one, second factor or not', () => {
    expect(startedWithPassword([totp, password])).toBe(true)
    expect(startedFromEmailLink([totp, password])).toBe(false)
  })

  it('reads the plain-string form some tokens use', () => {
    expect(startedWithPassword(['password'])).toBe(true)
    expect(startedFromEmailLink(['otp'])).toBe(true)
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
