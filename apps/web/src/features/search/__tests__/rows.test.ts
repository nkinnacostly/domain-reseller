import type { AvailabilityResult } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import type { PublicPriceRow } from '@/features/pricing/lib/public-row'
import {
  lengthRow,
  pickSuggestions,
  refusalNote,
  SUGGESTION_COUNT,
  toSearchRows,
} from '../lib/rows'

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

describe('international names in results (FR-S8)', () => {
  const prices = new Map([['com', price('com')]])

  it('keeps the ASCII form for the cart and shows the readable one', () => {
    const [row] = toSearchRows([result('xn--caf-dma', 'com')], prices)
    expect(row).toMatchObject({ domain: 'xn--caf-dma.com', display: 'café.com' })
  })

  it('says an extension did not take the name when its registry refused it', () => {
    const [row] = toSearchRows([result('xn--caf-dma', 'com', 'restricted')], prices)
    expect(row && refusalNote(row)).toBe(
      'Not available for this extension — its registry did not accept this international name',
    )
  })

  it('leaves an ordinary refusal to the card, which has its own words', () => {
    const [row] = toSearchRows([result('x', 'com', 'restricted')], prices)
    expect(row && refusalNote(row)).toBeNull()
  })
})

describe('lengthRow (FR-S9)', () => {
  const row = lengthRow('ab', 'io', { kind: 'too-short', min: 3, max: 63 })

  it('refuses the name, unpriced, without a supplier answer', () => {
    expect(row).toMatchObject({
      domain: 'ab.io',
      display: 'ab.io',
      status: 'restricted',
      price: null,
    })
  })

  it('says which rule it breaks', () => {
    expect(refusalNote(row)).toBe('Too short for .io (3–63 characters)')
  })

  it('is never offered as a suggestion', () => {
    expect(pickSuggestions([row], ['io'])).toEqual([])
  })
})
