import { describe, expect, it } from 'vitest'
import {
  BULK_RENEW_MAX,
  bulkRenewalTotals,
  bulkRenewHref,
  parseRenewIds,
  paymentCustomer,
  sharedMaxYears,
  sharedRegistrant,
} from '../lib/renewal'

const A = '4f5d3c1a-7b2e-4c8d-9a6f-1e2b3c4d5e6f'
const B = '5a6b7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'

describe('bulk renewal addresses (FR-P4, FR-P5)', () => {
  it('carries the ids in the address, and reads them back', () => {
    expect(bulkRenewHref([A, B])).toBe(`/app/domains/renew?ids=${A},${B}`)
    expect(parseRenewIds(`${A},${B}`)).toEqual([A, B])
  })

  it('keeps each id once, in order, and drops anything that is not an id', () => {
    expect(parseRenewIds(` ${B.toUpperCase()} ,${A},${B},nonsense,,'; drop`)).toEqual([B, A])
    expect(parseRenewIds(undefined)).toEqual([])
    expect(parseRenewIds('')).toEqual([])
  })

  it('fits 100 ids in an address well under proxy limits', () => {
    expect(BULK_RENEW_MAX).toBe(100)
    expect(bulkRenewHref(Array.from({ length: BULK_RENEW_MAX }, () => A)).length).toBeLessThan(
      4_000,
    )
  })
})

describe('sharedMaxYears', () => {
  it('offers up to what the tightest domain can take', () => {
    expect(
      sharedMaxYears([
        { ok: true, maxYears: 9 },
        { ok: true, maxYears: 4 },
        { ok: false, reason: 'Demo domains can’t be renewed.' },
      ]),
    ).toBe(4)
  })

  it('offers nothing when no domain can be renewed', () => {
    expect(sharedMaxYears([{ ok: false, reason: 'x' }])).toBeNull()
    expect(sharedMaxYears([])).toBeNull()
  })
})

describe('bulkRenewalTotals (N5: kobo, integers)', () => {
  const com = { renewal: { priceKobo: 1_870_000 } }
  const ng = { renewal: { priceKobo: 1_050_000 } }

  it('prices each line as the one-domain renewal does, and VAT once on the subtotal', () => {
    expect(bulkRenewalTotals([com, ng], 2, 7.5)).toEqual({
      lineKobo: [3_740_000, 2_100_000],
      subtotalKobo: 5_840_000,
      vatKobo: 438_000,
      totalKobo: 6_278_000,
    })
  })

  it('rounds VAT half-up to the kobo, as checkout does', () => {
    const odd = { renewal: { priceKobo: 1_001 } }
    // 7.5% of 1,001 is 75.075 kobo.
    expect(bulkRenewalTotals([odd], 1, 7.5)).toMatchObject({ vatKobo: 75, totalKobo: 1_076 })
  })

  it('refuses a period that is not a whole number of years', () => {
    expect(() => bulkRenewalTotals([com], 0, 7.5)).toThrow(RangeError)
  })
})

describe('sharedRegistrant — the customer on a renewal order', () => {
  const ada = { firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com' }

  it('is the domains’ registrant when they all share it, key order aside', () => {
    expect(
      sharedRegistrant([ada, { email: 'ada@example.com', lastName: 'Okafor', firstName: 'Ada' }]),
    ).toEqual(ada)
    expect(sharedRegistrant([ada])).toEqual(ada)
  })

  it('is nobody’s when the domains belong to different people', () => {
    expect(sharedRegistrant([ada, { ...ada, firstName: 'Chidi' }])).toBeNull()
  })

  it('is nobody’s when a domain has no registrant on record', () => {
    expect(sharedRegistrant([null, ada])).toBeNull()
    expect(sharedRegistrant([ada, null])).toBeNull()
    expect(sharedRegistrant([])).toBeNull()
  })

  it('compares nested values and lists too', () => {
    const tagged = { ...ada, tags: ['a', { b: 1 }] }
    expect(sharedRegistrant([tagged, { ...ada, tags: ['a', { b: 1 }] }])).toEqual(tagged)
    expect(sharedRegistrant([tagged, { ...ada, tags: ['a', { b: 2 }] }])).toBeNull()
  })
})

describe('paymentCustomer', () => {
  it('names the registrant, pays with the account email, and adds the phone', () => {
    expect(
      paymentCustomer(
        {
          firstName: 'Ada',
          lastName: 'Okafor',
          email: 'ada@okafor.ng',
          phone: '8031234567',
          phoneCountryCode: '234',
        },
        'ada@example.com',
      ),
    ).toEqual({ email: 'ada@example.com', name: 'Ada Okafor', phone: '+2348031234567' })
  })

  it('falls back to the email, then to "Customer", and leaves a missing phone out', () => {
    expect(paymentCustomer(null, 'ada@example.com')).toEqual({
      email: 'ada@example.com',
      name: 'ada@example.com',
    })
    expect(paymentCustomer({ email: 'ada@okafor.ng' }, undefined)).toEqual({
      email: 'ada@okafor.ng',
      name: 'Customer',
    })
    expect(paymentCustomer({}, null)).toEqual({ email: '', name: 'Customer' })
  })
})
