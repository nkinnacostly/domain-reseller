import type { AvailabilityResult } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import type { PublicPriceRow } from '@/features/pricing/lib/public-row'
import { pickSuggestions, SUGGESTION_COUNT, toSearchRows } from '../lib/rows'

const price = (tld: string, overrides: Partial<PublicPriceRow> = {}): PublicPriceRow => ({
  tld,
  register: '₦18,400',
  renew: '₦18,700',
  transfer: '₦17,500',
  renewalIsHigher: true,
  isCountryCode: tld.length === 2,
  maxPeriod: 10,
  requiresExtraFields: false,
  registerRank: 1_840_000,
  ...overrides,
})

const result = (name: string, tld: string, status: AvailabilityResult['status'] = 'available') => ({
  name,
  tld,
  domain: `${name}.${tld}`,
  status,
})

describe('toSearchRows', () => {
  const prices = new Map([
    ['com', price('com')],
    ['co', price('co')],
  ])

  it('shows no price rather than a guessed one when the catalogue has none (N5b)', () => {
    const [row] = toSearchRows([result('getpaid', 'zz')], prices)
    expect(row?.price).toBeNull()
  })

  it('carries the renewal price with every price (N8)', () => {
    const [row] = toSearchRows([result('getpaid', 'com')], prices)
    expect(row?.price).toMatchObject({
      register: '₦18,400',
      renew: '₦18,700',
      renewalIsHigher: true,
    })
  })

  it('marks the ICANN fee on generic extensions only (FR-S2)', () => {
    const rows = toSearchRows([result('getpaid', 'com'), result('getpaid', 'co')], prices)
    expect(rows.map((row) => row.price?.includesIcannFee)).toEqual([true, false])
  })
})

describe('pickSuggestions', () => {
  const prices = new Map([
    ['com', price('com')],
    ['net', price('net')],
  ])

  it('keeps only names that can be bought now', () => {
    const rows = toSearchRows(
      [
        result('getpaid', 'com', 'registered'),
        result('trypaid', 'com', 'premium'),
        result('usepaid', 'com'),
        result('gopaid', 'com', 'unknown'),
      ],
      prices,
    )
    expect(pickSuggestions(rows, ['com']).map((row) => row.domain)).toEqual(['usepaid.com'])
  })

  it('ranks the lead extension first, then the affix order (ADR-002)', () => {
    const rows = toSearchRows(
      [result('getpaid', 'net'), result('trypaid', 'com'), result('getpaid', 'com')],
      prices,
    )
    expect(pickSuggestions(rows, ['com', 'net']).map((row) => row.domain)).toEqual([
      'trypaid.com',
      'getpaid.com',
      'getpaid.net',
    ])
  })

  it(`stops at ${SUGGESTION_COUNT} (FR-S4)`, () => {
    const rows = toSearchRows(
      Array.from({ length: 20 }, (_, i) => result(`name${i}`, 'com')),
      prices,
    )
    expect(pickSuggestions(rows, ['com'])).toHaveLength(SUGGESTION_COUNT)
  })
})
