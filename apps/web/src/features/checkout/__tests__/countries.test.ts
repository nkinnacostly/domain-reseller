import { COUNTRY_CODES } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { registrantFormSchema, toContact } from '../lib/contact'
import { COUNTRY_NAMES, REGISTRANT_COUNTRIES } from '../lib/countries'

const byName = (a: string, b: string) => a.localeCompare(b, 'en')

describe('the registrant’s countries (FR-A4)', () => {
  it('offers every ISO 3166-1 country, each once', () => {
    expect(REGISTRANT_COUNTRIES).toHaveLength(COUNTRY_CODES.length)
    expect(new Set(REGISTRANT_COUNTRIES).size).toBe(COUNTRY_CODES.length)
    expect([...REGISTRANT_COUNTRIES].sort()).toEqual([...COUNTRY_CODES])
  })

  it('puts Nigeria first, then the rest in alphabetical order of name', () => {
    expect(REGISTRANT_COUNTRIES[0]).toBe('NG')
    const rest = REGISTRANT_COUNTRIES.slice(1).map((code) => COUNTRY_NAMES[code])
    expect(rest).toEqual([...rest].sort(byName))
    expect(rest.slice(0, 3)).toEqual(['Afghanistan', 'Åland Islands', 'Albania'])
    expect(rest.at(-1)).toBe('Zimbabwe')
  })

  it('keeps the name map itself in alphabetical order, so a new entry lands in place', () => {
    const names = Object.values(COUNTRY_NAMES)
    expect(names).toEqual([...names].sort(byName))
  })

  it('names every country in words, never by its code', () => {
    for (const code of COUNTRY_CODES) {
      expect(COUNTRY_NAMES[code].length).toBeGreaterThan(2)
      expect(COUNTRY_NAMES[code]).not.toBe(code)
    }
    expect(COUNTRY_NAMES.NG).toBe('Nigeria')
    expect(COUNTRY_NAMES.GB).toBe('United Kingdom')
    expect(COUNTRY_NAMES.CI).toBe('Côte d’Ivoire')
  })
})

describe('registrantFormSchema — the country, in step with the list', () => {
  const valid = {
    firstName: 'Ada',
    lastName: 'Okafor',
    email: 'ada@example.com',
    phoneCountryCode: '44',
    phone: '7700 900123',
    addressLine1: '1 High Street',
    city: 'London',
    state: 'London',
    zipCode: 'SW1A 1AA',
    country: 'GB',
  }

  it.each(REGISTRANT_COUNTRIES.filter((_, index) => index % 25 === 0))(
    'accepts %s, as the form offers it',
    (country) => {
      expect(registrantFormSchema.safeParse({ ...valid, country }).success).toBe(true)
    },
  )

  it('accepts every country the form offers, and hands the registry its code', () => {
    for (const country of REGISTRANT_COUNTRIES) {
      expect(toContact(registrantFormSchema.parse({ ...valid, country })).country).toBe(country)
    }
  })

  it('reads a lower-case or padded code as the country it names', () => {
    expect(registrantFormSchema.parse({ ...valid, country: ' ke ' }).country).toBe('KE')
  })

  it.each([
    ['nothing chosen', ''],
    ['an unassigned code', 'ZZ'],
    ['a code outside the standard', 'XK'],
    ['a reserved code', 'UK'],
    ['a three-letter code', 'NGA'],
  ])('refuses %s with “Choose a country”', (_, country) => {
    const result = registrantFormSchema.safeParse({ ...valid, country })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['Choose a country'])
  })
})
