import { describe, expect, it } from 'vitest'
import { nationalNumber, registrantFormSchema, toContact } from '../lib/contact'
import { wholesaleCostUsd } from '../lib/cost'
import { parseNameservers } from '../lib/nameservers'
import { assessTransaction } from '../lib/payment'

describe('nationalNumber (FR-A4)', () => {
  it.each([
    ['0803 123 4567', '8031234567'],
    ['+234 803 123 4567', '8031234567'],
    ['00234 803 123 4567', '8031234567'],
    ['803-123-4567', '8031234567'],
  ])('reads %s as the E.164 national number', (raw, expected) => {
    expect(nationalNumber(raw, '234')).toBe(expected)
  })

  it('leaves a local number that happens to start with the code alone', () => {
    // No plus: 234… here is part of the number, not a dialling code.
    expect(nationalNumber('2345678901', '44')).toBe('2345678901')
  })
})

describe('registrant form', () => {
  const valid = {
    firstName: ' Ada ',
    lastName: 'Okafor',
    company: '',
    email: 'Ada@Example.com',
    phoneCountryCode: '+234',
    phone: '0803 123 4567',
    addressLine1: '12 Admiralty Way',
    addressLine2: '',
    city: 'Lagos',
    state: 'Lagos',
    zipCode: '100001',
    country: 'ng',
  }

  it('becomes the supplier contact shape, with empty optionals dropped', () => {
    expect(toContact(registrantFormSchema.parse(valid))).toEqual({
      firstName: 'Ada',
      lastName: 'Okafor',
      email: 'ada@example.com',
      phoneCountryCode: '234',
      phone: '8031234567',
      addressLine1: '12 Admiralty Way',
      city: 'Lagos',
      state: 'Lagos',
      zipCode: '100001',
      country: 'NG',
    })
  })

  it('names each missing field', () => {
    const result = registrantFormSchema.safeParse({ ...valid, city: '', zipCode: '' })
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Enter a city',
      'Enter a postcode',
    ])
  })
})

describe('parseNameservers (FR-C10)', () => {
  it('means "later" when left empty', () => {
    expect(parseNameservers('  ')).toEqual({ ok: true, nameservers: null })
  })

  it('accepts one per line, commas or spaces, in any case', () => {
    expect(parseNameservers('NS1.Host.com\nns2.host.com.,ns3.host.com')).toEqual({
      ok: true,
      nameservers: ['ns1.host.com', 'ns2.host.com', 'ns3.host.com'],
    })
  })

  it('refuses a single nameserver, a duplicate, or a non-hostname — before payment', () => {
    expect(parseNameservers('ns1.host.com').ok).toBe(false)
    expect(parseNameservers('ns1.host.com ns1.host.com').ok).toBe(false)
    expect(parseNameservers('ns1.host.com not_a_host').ok).toBe(false)
  })
})

describe('wholesaleCostUsd (FR-C8)', () => {
  const costs = new Map([
    ['com', { registerUsd: 11.31, renewUsd: 11.51, isCountryCode: false, firstTermYears: 1 }],
    ['co', { registerUsd: 19.49, renewUsd: 38.99, isCountryCode: true, firstTermYears: 1 }],
    // .ai as the sync stores it: $99.90 a year, sold from two years.
    ['ai', { registerUsd: 99.9, renewUsd: 99.9, isCountryCode: true, firstTermYears: 2 }],
  ])

  it('adds registration, renewals and the ICANN fee per year on generic extensions', () => {
    expect(wholesaleCostUsd([{ tld: 'com', periodYears: 2 }], costs, 0.2)).toBe(23.22)
  })

  it('adds no ICANN fee on country extensions', () => {
    expect(wholesaleCostUsd([{ tld: 'co', periodYears: 1 }], costs, 0.2)).toBe(19.49)
  })

  it('refuses to guess the cost of an extension it has no price for', () => {
    expect(() => wholesaleCostUsd([{ tld: 'xyz', periodYears: 1 }], costs, 0.2)).toThrow()
  })

  it('costs a block-sold extension at what the supplier lists for the period (.ai)', () => {
    // The supplier's listed .ai prices on 29 Sept 2026: 2 years $199.80, 4 years $399.60.
    expect(wholesaleCostUsd([{ tld: 'ai', periodYears: 2 }], costs, 0.2)).toBe(199.8)
    expect(wholesaleCostUsd([{ tld: 'ai', periodYears: 4 }], costs, 0.2)).toBe(399.6)
  })

  it('refuses to cost a period shorter than the first term the registry sells', () => {
    expect(() => wholesaleCostUsd([{ tld: 'ai', periodYears: 1 }], costs, 0.2)).toThrow(
      /not sold for 1 years/,
    )
  })
})

describe('assessTransaction (SEC-7)', () => {
  const order = { txRef: 'ord_1', totalKobo: 1_978_000 }
  const tx = { tx_ref: 'ord_1', status: 'successful', amount: 19_780, currency: 'NGN' }

  it('accepts a successful payment of the full amount', () => {
    expect(assessTransaction(tx, order)).toBe('paid')
  })

  it('refuses a transaction for a different order, whatever its status', () => {
    expect(assessTransaction({ ...tx, tx_ref: 'ord_2' }, order)).toBe('wrong_order')
    expect(assessTransaction({ ...tx, tx_ref: 'ord_2', status: 'failed' }, order)).toBe(
      'wrong_order',
    )
  })

  it('never lets a short payment pay the order — it is refunded instead', () => {
    expect(assessTransaction({ ...tx, amount: 100 }, order)).toBe('underpaid')
    expect(assessTransaction({ ...tx, amount: 19_779.99 }, order)).toBe('underpaid')
  })

  it('accepts more than the total — the excess is refunded', () => {
    expect(assessTransaction({ ...tx, amount: 20_000 }, order)).toBe('paid')
  })

  it('refuses another currency, even at the right number', () => {
    expect(assessTransaction({ ...tx, currency: 'USD' }, order)).toBe('wrong_currency')
  })

  it('waits on a pending payment and reports a failed one', () => {
    expect(assessTransaction({ ...tx, status: 'pending' }, order)).toBe('pending')
    expect(assessTransaction({ ...tx, status: 'failed' }, order)).toBe('failed')
  })
})
