import { describe, expect, it } from 'vitest'
import { checkoutOpenTo } from '../lib/access'

describe('checkoutOpenTo (pre-launch gate)', () => {
  it('is open to everyone when no allowlist is set', () => {
    expect(checkoutOpenTo('anyone@example.com', undefined)).toBe(true)
    expect(checkoutOpenTo('anyone@example.com', '  ')).toBe(true)
  })

  it('lets in only listed accounts, ignoring case and spacing', () => {
    const list = ' Owner@Example.com , second@example.com,'
    expect(checkoutOpenTo('owner@example.com', list)).toBe(true)
    expect(checkoutOpenTo('SECOND@example.com', list)).toBe(true)
    expect(checkoutOpenTo('stranger@example.com', list)).toBe(false)
  })

  it('keeps out an account with no email', () => {
    expect(checkoutOpenTo(undefined, 'owner@example.com')).toBe(false)
  })
})
