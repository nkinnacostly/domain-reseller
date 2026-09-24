import { describe, expect, it } from 'vitest'
import {
  authCodeSchema,
  TRANSFER_REFUSALS,
  transferCheckRequestSchema,
  transferCheckResultSchema,
} from './index'

describe('authCodeSchema', () => {
  it('refuses an empty code with the words to fix it', () => {
    const parsed = authCodeSchema.safeParse('   ')
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toMatch(/Enter the transfer code/)
  })

  it('refuses a code longer than the vault holds', () => {
    expect(authCodeSchema.safeParse('x'.repeat(256)).success).toBe(false)
    expect(authCodeSchema.safeParse('x'.repeat(255)).success).toBe(true)
  })

  it('refuses a paste that carries line breaks or other control characters', () => {
    for (const value of ['abc\ndef', 'abc\tdef', 'abc\u0000def']) {
      expect(authCodeSchema.safeParse(value).success).toBe(false)
    }
  })

  it('keeps the code exactly as issued, minus stray spaces at the ends', () => {
    expect(authCodeSchema.parse('  aB3$-9_x!Q  ')).toBe('aB3$-9_x!Q')
  })
})

describe('transferCheckRequestSchema', () => {
  it('normalises the domain and says which side to ask', () => {
    expect(
      transferCheckRequestSchema.parse({
        domainName: 'GetPaid.COM',
        authCode: 'code-1',
        testMode: true,
      }),
    ).toEqual({ domainName: 'getpaid.com', authCode: 'code-1', testMode: true })
  })

  it('refuses a request that does not say test or live', () => {
    expect(
      transferCheckRequestSchema.safeParse({ domainName: 'getpaid.com', authCode: 'code-1' })
        .success,
    ).toBe(false)
  })

  it('refuses a name without an extension', () => {
    expect(
      transferCheckRequestSchema.safeParse({
        domainName: 'getpaid',
        authCode: 'code-1',
        testMode: false,
      }).success,
    ).toBe(false)
  })
})

describe('transferCheckResultSchema', () => {
  it('reads a yes', () => {
    expect(transferCheckResultSchema.parse({ transferable: true })).toEqual({ transferable: true })
  })

  it('reads a no with each reason, and refuses a no without one', () => {
    for (const reason of TRANSFER_REFUSALS) {
      expect(transferCheckResultSchema.parse({ transferable: false, reason })).toEqual({
        transferable: false,
        reason,
      })
    }
    expect(transferCheckResultSchema.safeParse({ transferable: false }).success).toBe(false)
    expect(
      transferCheckResultSchema.safeParse({ transferable: false, reason: 'Something else' })
        .success,
    ).toBe(false)
  })
})
