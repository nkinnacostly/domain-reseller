import { describe, expect, it } from 'vitest'
import { parseSearchQuery, searchHref } from '../lib/query'

describe('parseSearchQuery', () => {
  it('accepts a bare label', () => {
    expect(parseSearchQuery('getpaid')).toEqual({ stem: 'getpaid', tld: null, isValid: true })
  })

  it('splits a label and extension', () => {
    expect(parseSearchQuery('getpaid.ng')).toEqual({ stem: 'getpaid', tld: 'ng', isValid: true })
  })

  it('keeps a multi-label extension intact', () => {
    expect(parseSearchQuery('getpaid.com.ng')).toEqual({
      stem: 'getpaid',
      tld: 'com.ng',
      isValid: true,
    })
  })

  it.each([
    ['https://getpaid.ng', 'getpaid', 'ng'],
    ['http://www.getpaid.ng', 'getpaid', 'ng'],
    ['www.getpaid.ng', 'getpaid', 'ng'],
    ['  GetPaid.NG  ', 'getpaid', 'ng'],
    ['getpaid.ng/', 'getpaid', 'ng'],
    ['getpaid.ng/pricing?ref=x', 'getpaid', 'ng'],
    ['getpaid.ng.', 'getpaid', 'ng'],
  ])('cleans %s — people paste URLs', (input, stem, tld) => {
    expect(parseSearchQuery(input)).toEqual({ stem, tld, isValid: true })
  })

  it('rejects empty input', () => {
    expect(parseSearchQuery('   ').isValid).toBe(false)
  })

  it('rejects a label with a leading hyphen', () => {
    expect(parseSearchQuery('-bad.com').isValid).toBe(false)
  })

  it('rejects a label with a trailing hyphen', () => {
    expect(parseSearchQuery('bad-.com').isValid).toBe(false)
  })

  it('rejects an underscore, which DNS does not allow in a hostname label', () => {
    expect(parseSearchQuery('under_score.com').isValid).toBe(false)
  })

  it('rejects a label longer than 63 characters', () => {
    expect(parseSearchQuery(`${'a'.repeat(64)}.com`).isValid).toBe(false)
  })

  it('accepts a label of exactly 63 characters', () => {
    expect(parseSearchQuery(`${'a'.repeat(63)}.com`).isValid).toBe(true)
  })

  it('rejects a malformed extension', () => {
    expect(parseSearchQuery('site.-ng').isValid).toBe(false)
  })
})

describe('searchHref', () => {
  it('builds a canonical URL for a full domain', () => {
    expect(searchHref('GetPaid.COM.NG')).toBe('/search?q=getpaid.com.ng')
  })

  it('builds a URL for a bare stem', () => {
    expect(searchHref('getpaid')).toBe('/search?q=getpaid')
  })

  it('falls back to the bare search page for unusable input', () => {
    expect(searchHref('   ')).toBe('/search')
  })
})
