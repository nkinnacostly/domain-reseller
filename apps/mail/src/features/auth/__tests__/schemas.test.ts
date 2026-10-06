import { describe, expect, it } from 'vitest'
import { changePasswordSchema, signUpSchema, totpCodeSchema } from '../schemas'

describe('auth schemas', () => {
  it('rejects a short password with a message that says the rule', () => {
    const result = signUpSchema.safeParse({ fullName: 'Ada', email: 'a@b.co', password: 'short' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Use at least 10 characters')
  })

  it('refuses passwords past bcrypt’s 72-byte limit rather than silently truncating', () => {
    const result = signUpSchema.safeParse({
      fullName: 'Ada',
      email: 'a@b.co',
      password: 'x'.repeat(73),
    })
    expect(result.success).toBe(false)
  })

  it('normalises the email so Ada@Example.com and ada@example.com are one account', () => {
    const parsed = signUpSchema.parse({
      fullName: ' Ada ',
      email: '  Ada@Example.COM ',
      password: 'long-enough-1',
    })
    expect(parsed.email).toBe('ada@example.com')
    expect(parsed.fullName).toBe('Ada')
  })

  it('puts a mismatched confirmation on the confirmation field', () => {
    const result = changePasswordSchema.safeParse({
      current: 'old',
      password: 'new-password-1',
      confirm: 'new-password-2',
    })
    expect(result.error?.issues[0]?.path).toEqual(['confirm'])
  })

  it('accepts a code pasted with spaces', () => {
    expect(totpCodeSchema.parse('123 456')).toBe('123456')
    expect(totpCodeSchema.safeParse('12345').success).toBe(false)
    expect(totpCodeSchema.safeParse('abcdef').success).toBe(false)
  })
})
