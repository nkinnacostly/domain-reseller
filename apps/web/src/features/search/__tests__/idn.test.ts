import { describe, expect, it } from 'vitest'
import {
  isIdn,
  latinLookalike,
  mixedScripts,
  toAsciiHost,
  toUnicodeHost,
  toUnicodeLabel,
} from '../lib/idn'

describe('toAsciiHost (FR-S8)', () => {
  it('refuses characters that mean something else to a URL, so nothing smuggles in a host', () => {
    expect(toAsciiHost('café@evil.com')).toBeNull()
    expect(toAsciiHost('café:8080')).toBeNull()
    expect(toAsciiHost('ca_fé')).toBeNull()
  })

  it('refuses what no host name can be', () => {
    expect(toAsciiHost('café.123')).toBeNull()
  })

  it('keeps plain ASCII away from the URL parser, which reads 123 as an IP address', () => {
    expect(toAsciiHost('123')).toBe('123')
    expect(toAsciiHost('GetPaid.com')).toBe('getpaid.com')
  })

  it.each([
    ['café', 'xn--caf-dma'],
    ['café.com', 'xn--caf-dma.com'],
    ['ọmọ', 'xn--m-jxmb'],
    ['münchen', 'xn--mnchen-3ya'],
    ['日本語', 'xn--wgv71a119e'],
    ['CAFÉ', 'xn--caf-dma'],
  ])('writes %s as %s', (input, ascii) => {
    expect(toAsciiHost(input)).toBe(ascii)
  })

  it('maps full-width letters to the plain ones they stand for', () => {
    expect(toAsciiHost('ＡＢＣ')).toBe('abc')
  })
})

describe('toUnicodeLabel', () => {
  it('refuses an xn-- label that is not a real encoding', () => {
    expect(toUnicodeLabel('xn--zz')).toBeNull()
    expect(toUnicodeLabel('xn--a')).toBeNull()
    expect(toUnicodeLabel('xn--9999999999a')).toBeNull()
    // Punycode digits are lowercase letters and numbers only.
    expect(toUnicodeLabel('xn--caf-DMA')).toBeNull()
  })

  it('refuses an xn-- label that decodes to plain ASCII', () => {
    // "abc-" encodes to nothing but its own basic code points.
    expect(toUnicodeLabel('xn--abc-')).toBeNull()
  })

  it.each([
    ['xn--caf-dma', 'café'],
    ['xn--m-jxmb', 'ọmọ'],
    ['xn--80ak6aa92e', 'аррӏе'],
    ['xn--wgv71a119e', '日本語'],
    ['xn--vi8h', '🍕'],
  ])('reads %s as %s', (label, unicode) => {
    expect(toUnicodeLabel(label)).toBe(unicode)
  })

  it('leaves an ordinary label alone', () => {
    expect(toUnicodeLabel('getpaid')).toBe('getpaid')
  })
})

describe('toUnicodeHost and isIdn', () => {
  it('reads a whole name label by label', () => {
    expect(toUnicodeHost('xn--caf-dma.com')).toBe('café.com')
    expect(isIdn('xn--caf-dma.com')).toBe(true)
  })

  it('leaves a label that does not decode as it is, rather than dropping it', () => {
    expect(toUnicodeHost('xn--zz.com')).toBe('xn--zz.com')
  })

  it('knows an ordinary name is not international', () => {
    expect(toUnicodeHost('getpaid.com')).toBe('getpaid.com')
    expect(isIdn('getpaid.com')).toBe(false)
  })
})

describe('mixedScripts — the homograph check (FR-S8)', () => {
  it('catches one Cyrillic letter in a Latin name', () => {
    // The second letter is Cyrillic а (U+0430).
    expect(mixedScripts('pаypal')).toEqual(['Latin', 'Cyrillic'])
  })

  it('catches Greek among Latin', () => {
    expect(mixedScripts('gοogle')).toEqual(['Latin', 'Greek'])
  })

  it('allows a name in one script, digits and hyphens included', () => {
    expect(mixedScripts('café-2024')).toBeNull()
    expect(mixedScripts('аррӏе')).toBeNull()
  })

  it('allows Latin with a script that has no Latin lookalikes', () => {
    expect(mixedScripts('tokyo日本')).toBeNull()
  })
})

describe('latinLookalike', () => {
  it('names the Latin word an all-Cyrillic name can pass for', () => {
    expect(latinLookalike('аррӏе')).toEqual({ latin: 'apple', script: 'Cyrillic' })
  })

  it('names the script when it is Greek', () => {
    expect(latinLookalike('τοκ')).toEqual({ latin: 'tok', script: 'Greek' })
  })

  it('keeps digits and hyphens in the lookalike', () => {
    expect(latinLookalike('ра-1')).toEqual({ latin: 'pa-1', script: 'Cyrillic' })
  })

  it('says nothing about a name with a letter that looks like no Latin one', () => {
    expect(latinLookalike('привет')).toBeNull()
    expect(latinLookalike('café')).toBeNull()
  })

  it('says nothing about digits alone', () => {
    expect(latinLookalike('2024')).toBeNull()
  })
})
