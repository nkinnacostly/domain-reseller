import { describe, expect, it } from 'vitest'
import { mailUrl, oauthCallbackUrl, SECURITY_PAGE } from '../lib/links'
import { safeNext } from '../lib/redirect'
import {
  describeHold,
  hasFreshSecondFactor,
  resetHoldUntil,
  startedFromEmailLink,
  startedWithStrongSignIn,
} from '../lib/security'

const ORIGIN = 'https://emails.mydomainshub.com'

describe('safeNext — never an open redirect', () => {
  it('keeps a path of ours, its query and its hash', () => {
    expect(safeNext('/invite?token=abc', ORIGIN)).toBe('/invite?token=abc')
    expect(safeNext(`${ORIGIN}/dashboard/settings#two-factor`, ORIGIN)).toBe(
      '/dashboard/settings#two-factor',
    )
  })

  it.each([
    [null],
    [''],
    ['https://evil.test/dashboard'],
    ['//evil.test'],
    ['/\\evil.test'],
    ['/'],
    ['/sign-in?next=/x'],
    ['/auth/confirm'],
    ['/verify'],
    ['http://[::1'],
  ])('falls back to the dashboard for %s', (next) => {
    expect(safeNext(next, ORIGIN)).toBe('/dashboard')
  })

  it('takes another fallback when asked', () => {
    expect(safeNext(undefined, ORIGIN, '/onboarding')).toBe('/onboarding')
  })
})

describe('the shop’s rules for a shared sign-in (FR-A3, FR-A6)', () => {
  const now = new Date('2026-10-06T12:00:00Z')

  it('holds two-factor changes for a day after a reset, then lets go', () => {
    expect(resetHoldUntil(null, now)).toBeNull()
    expect(resetHoldUntil('2026-10-06T11:00:00Z', now)?.toISOString()).toBe(
      '2026-10-07T11:00:00.000Z',
    )
    expect(resetHoldUntil('2026-10-05T11:00:00Z', now)).toBeNull()
    expect(describeHold(new Date('2026-10-07T11:00:00Z'))).toMatch(
      /paused for 24 hours after a password reset — until Wednesday/,
    )
  })

  it('tells a password or Google sign-in from an email link', () => {
    expect(startedWithStrongSignIn(['password'])).toBe(true)
    expect(startedWithStrongSignIn([{ method: 'oauth', timestamp: 1 }])).toBe(true)
    expect(startedWithStrongSignIn(['otp'])).toBe(false)
    expect(startedFromEmailLink(['otp'])).toBe(true)
    expect(startedFromEmailLink(['otp', 'password'])).toBe(false)
    expect(startedFromEmailLink([{ method: 'oauth', timestamp: 1 }])).toBe(false)
  })

  it('counts a code only from the last 15 minutes', () => {
    const at = now.getTime() / 1000
    expect(hasFreshSecondFactor([{ method: 'totp', timestamp: at - 60 }], now)).toBe(true)
    expect(hasFreshSecondFactor([{ method: 'totp', timestamp: at - 16 * 60 }], now)).toBe(false)
    expect(hasFreshSecondFactor(['totp'], now)).toBe(false)
  })
})

describe('links back to Mail', () => {
  it('builds them on Mail’s own host', () => {
    expect(mailUrl('/dashboard')).toBe('http://localhost:3001/dashboard')
    expect(oauthCallbackUrl('/dashboard?x=1')).toBe(
      'http://localhost:3001/auth/callback?flow=oauth&next=%2Fdashboard%3Fx%3D1',
    )
    expect(SECURITY_PAGE).toBe('/dashboard/settings/security')
  })
})
