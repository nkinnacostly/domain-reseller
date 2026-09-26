import { describe, expect, it } from 'vitest'
import {
  COUNTRY_CODES,
  contactSchema,
  countryCode,
  domainNameSchema,
  domainStemSchema,
  NAMESERVERS_MAX,
  NAMESERVERS_MIN,
  nameserverSchema,
  nameserverSetSchema,
} from './index'

describe('COUNTRY_CODES (ISO 3166-1 alpha-2)', () => {
  it('lists all 249 assigned codes, once each, in order', () => {
    expect(COUNTRY_CODES).toHaveLength(249)
    expect(new Set(COUNTRY_CODES).size).toBe(249)
    expect([...COUNTRY_CODES].sort()).toEqual([...COUNTRY_CODES])
  })

  it('holds only two capital letters per code', () => {
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/)
  })

  it('accepts every code on the list, and nothing else', () => {
    for (const code of COUNTRY_CODES) expect(countryCode.safeParse(code).success).toBe(true)
    expect(countryCode.safeParse('NGA').success).toBe(false)
    expect(countryCode.safeParse('ZZ').success).toBe(false)
  })
})

describe('domainNameSchema', () => {
  it.each(['example.com', 'my-site.com.ng', 'a1.io'])('accepts %s', (value) => {
    expect(domainNameSchema.parse(value)).toBe(value)
  })

  it('lowercases and trims', () => {
    expect(domainNameSchema.parse('  ExAmPle.COM ')).toBe('example.com')
  })

  it.each([
    ['nodot', 'missing extension'],
    ['-bad.com', 'leading hyphen'],
    ['bad-.com', 'trailing hyphen'],
    ['spa ce.com', 'space'],
    ['under_score.com', 'underscore'],
  ])('rejects %s (%s)', (value) => {
    expect(domainNameSchema.safeParse(value).success).toBe(false)
  })
})

describe('domainStemSchema', () => {
  it('rejects a stem longer than a DNS label allows', () => {
    expect(domainStemSchema.safeParse('a'.repeat(64)).success).toBe(false)
  })

  it('accepts a 63-character stem', () => {
    expect(domainStemSchema.safeParse('a'.repeat(63)).success).toBe(true)
  })
})

describe('nameserverSchema', () => {
  it('accepts a normal nameserver', () => {
    expect(nameserverSchema.parse('NS1.Example.COM')).toBe('ns1.example.com')
  })

  it('rejects a bare hostname with no dot', () => {
    expect(nameserverSchema.safeParse('ns1').success).toBe(false)
  })
})

describe('nameserverSetSchema', () => {
  it('requires at least two', () => {
    expect(nameserverSetSchema.safeParse(['ns1.example.com']).success).toBe(false)
  })

  it('accepts a normal pair', () => {
    expect(nameserverSetSchema.safeParse(['ns1.example.com', 'ns2.example.com']).success).toBe(true)
  })

  it('rejects duplicates, which registries reject too', () => {
    const result = nameserverSetSchema.safeParse(['ns1.example.com', 'ns1.example.com'])
    expect(result.success).toBe(false)
  })

  it('rejects more than 13', () => {
    const many = Array.from({ length: 14 }, (_, i) => `ns${i}.example.com`)
    expect(nameserverSetSchema.safeParse(many).success).toBe(false)
  })

  it('publishes the bounds it enforces, for forms to size themselves by', () => {
    const set = (length: number) => Array.from({ length }, (_, i) => `ns${i}.example.com`)
    expect([NAMESERVERS_MIN, NAMESERVERS_MAX]).toEqual([2, 13])
    expect(nameserverSetSchema.safeParse(set(NAMESERVERS_MIN)).success).toBe(true)
    expect(nameserverSetSchema.safeParse(set(NAMESERVERS_MAX)).success).toBe(true)
    expect(nameserverSetSchema.safeParse(set(NAMESERVERS_MIN - 1)).success).toBe(false)
    expect(nameserverSetSchema.safeParse(set(NAMESERVERS_MAX + 1)).success).toBe(false)
  })
})

describe('contactSchema', () => {
  const valid = {
    firstName: 'Ada',
    lastName: 'Obi',
    email: 'ada@example.com',
    phoneCountryCode: '234',
    phone: '8012345678',
    addressLine1: '12 Awolowo Road',
    city: 'Lagos',
    state: 'Lagos',
    zipCode: '101233',
    country: 'NG',
  }

  it('accepts a valid Nigerian contact', () => {
    expect(contactSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a lowercase country code', () => {
    expect(contactSchema.safeParse({ ...valid, country: 'ng' }).success).toBe(false)
  })

  it.each(['GB', 'US', 'CI', 'AX', 'ZW'])('accepts a contact in %s', (country) => {
    expect(contactSchema.safeParse({ ...valid, country }).success).toBe(true)
  })

  it.each([
    ['ZZ', 'unassigned'],
    ['XK', 'user-assigned, not in the standard'],
    ['UK', 'reserved — the code is GB'],
    ['EU', 'reserved'],
  ])('rejects %s (%s), which a registry would refuse after payment', (country) => {
    expect(contactSchema.safeParse({ ...valid, country }).success).toBe(false)
  })

  it('rejects a phone number containing formatting characters', () => {
    expect(contactSchema.safeParse({ ...valid, phone: '+234 801 234 5678' }).success).toBe(false)
  })

  it('rejects an invalid email', () => {
    expect(contactSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false)
  })
})
