import { describe, expect, it } from 'vitest'
import { describeProblem, displayQuery, parseSearchQuery, searchHref } from '../lib/query'

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

describe('parseSearchQuery — names in other scripts (FR-S8)', () => {
  it('refuses a name mixing lookalike alphabets, and says which', () => {
    // The second letter is Cyrillic а (U+0430).
    expect(parseSearchQuery('pаypal.com')).toEqual({
      stem: 'xn--pypal-4ve',
      tld: null,
      isValid: false,
      problem: { kind: 'mixed-script', scripts: ['Latin', 'Cyrillic'] },
    })
  })

  it('refuses an xn-- label that is not a real encoding', () => {
    expect(parseSearchQuery('xn--zz.com').isValid).toBe(false)
    expect(parseSearchQuery('getpaid.xn--zz').isValid).toBe(false)
  })

  it('refuses a name that would start or end with a hyphen once read', () => {
    expect(parseSearchQuery('-café.com').isValid).toBe(false)
    expect(parseSearchQuery('café-.com').isValid).toBe(false)
  })

  it('refuses input no host name can be', () => {
    expect(parseSearchQuery('café@evil.com')).toEqual({ stem: '', tld: null, isValid: false })
  })

  it('searches the ASCII form of a Unicode name', () => {
    expect(parseSearchQuery('Café.com')).toEqual({
      stem: 'xn--caf-dma',
      tld: 'com',
      isValid: true,
    })
  })

  it('accepts the ASCII form typed directly', () => {
    expect(parseSearchQuery('xn--caf-dma.com')).toEqual({
      stem: 'xn--caf-dma',
      tld: 'com',
      isValid: true,
    })
  })

  it('cleans a pasted international URL like any other', () => {
    expect(parseSearchQuery('https://www.ọmọ.africa/about')).toEqual({
      stem: 'xn--m-jxmb',
      tld: 'africa',
      isValid: true,
    })
  })

  it('does not take a name in one other alphabet for a lookalike', () => {
    expect(parseSearchQuery('аррӏе.com').isValid).toBe(true)
  })
})

describe('displayQuery', () => {
  it('shows an international name as people read it', () => {
    expect(displayQuery({ stem: 'xn--caf-dma', tld: 'com' })).toBe('café.com')
  })

  it('shows a bare stem without an extension', () => {
    expect(displayQuery({ stem: 'getpaid', tld: null })).toBe('getpaid')
  })
})

describe('describeProblem', () => {
  it('names the alphabets and says what to do', () => {
    expect(describeProblem({ kind: 'mixed-script', scripts: ['Latin', 'Cyrillic'] })).toBe(
      "This name mixes letters from different alphabets (Latin and Cyrillic). Names like that are used to imitate other websites, so we don't sell them. Type it in one alphabet.",
    )
  })
})

describe('searchHref', () => {
  it('carries the readable form of an international name', () => {
    expect(searchHref('xn--caf-dma.com')).toBe(`/search?q=${encodeURIComponent('café.com')}`)
  })

  it('sends a mixed-script name to the bare search page', () => {
    expect(searchHref('pаypal.com')).toBe('/search')
  })

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
