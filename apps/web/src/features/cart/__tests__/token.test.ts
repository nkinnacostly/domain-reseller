import { describe, expect, it } from 'vitest'
import { hashCartToken, newCartToken } from '../lib/token'

describe('cart tokens', () => {
  it('are long and random', () => {
    const a = newCartToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newCartToken()).not.toBe(a)
  })

  it('are stored only as a SHA-256 the database check accepts', () => {
    const hash = hashCartToken('token')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashCartToken('token')).toBe(hash)
  })
})
