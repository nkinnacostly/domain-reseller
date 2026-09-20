import { describe, expect, it } from 'vitest'
import {
  contactSchema,
  domainNameSchema,
  domainStemSchema,
  nameserverSchema,
  nameserverSetSchema,
} from './index'

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

  it('rejects a phone number containing formatting characters', () => {
    expect(contactSchema.safeParse({ ...valid, phone: '+234 801 234 5678' }).success).toBe(false)
  })

  it('rejects an invalid email', () => {
    expect(contactSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false)
  })
})
