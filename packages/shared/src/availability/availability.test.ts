import { describe, expect, it } from 'vitest'
import { AVAILABILITY_LIMITS, availabilityRequestSchema } from './index'

describe('availabilityRequestSchema', () => {
  it('refuses a request that would fan out into too many supplier calls', () => {
    const tlds = Array.from({ length: AVAILABILITY_LIMITS.maxTlds + 1 }, (_, i) => `t${i}x`)
    expect(availabilityRequestSchema.safeParse({ names: ['getpaid'], tlds }).success).toBe(false)
  })

  it('refuses more names than one call should carry', () => {
    const names = Array.from({ length: AVAILABILITY_LIMITS.maxNames + 1 }, (_, i) => `name${i}`)
    expect(availabilityRequestSchema.safeParse({ names, tlds: ['com'] }).success).toBe(false)
  })

  it('refuses names that are not a single DNS label', () => {
    for (const name of ['get paid', '-getpaid', 'getpaid.com', '']) {
      expect(availabilityRequestSchema.safeParse({ names: [name], tlds: ['com'] }).success).toBe(
        false,
      )
    }
  })

  it('refuses an extension that is not one', () => {
    expect(
      availabilityRequestSchema.safeParse({ names: ['getpaid'], tlds: ['.com'] }).success,
    ).toBe(false)
    expect(availabilityRequestSchema.safeParse({ names: ['getpaid'], tlds: ['c'] }).success).toBe(
      false,
    )
  })

  it('normalises case and accepts multi-label extensions', () => {
    expect(availabilityRequestSchema.parse({ names: ['GetPaid'], tlds: ['COM', 'co.uk'] })).toEqual(
      {
        names: ['getpaid'],
        tlds: ['com', 'co.uk'],
        priority: 'normal',
      },
    )
  })
})
