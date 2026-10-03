import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from '../csv'

describe('csvCell — RFC 4180 quoting', () => {
  it('leaves a plain value as it is', () => {
    expect(csvCell('getpaid.com')).toBe('getpaid.com')
    expect(csvCell(3)).toBe('3')
    expect(csvCell(true)).toBe('true')
  })

  it('writes nothing for a missing value', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('quotes a comma, a quote or a line break, doubling any quote', () => {
    expect(csvCell('Acme, Ltd')).toBe('"Acme, Ltd"')
    expect(csvCell('the "big" client')).toBe('"the ""big"" client"')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"')
  })

  it('quotes leading or trailing spaces, so a spreadsheet keeps them', () => {
    expect(csvCell(' padded')).toBe('" padded"')
  })
})

describe('csvCell — formula injection', () => {
  it('turns every cell a spreadsheet would run into text', () => {
    expect(csvCell('=HYPERLINK("http://evil.test","click")')).toBe(
      `"'=HYPERLINK(""http://evil.test"",""click"")"`,
    )
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\tcmd')).toBe(`'\tcmd`)
    expect(csvCell('\r=1')).toBe(`"'\r=1"`)
  })

  it('leaves the same characters alone anywhere but the start', () => {
    expect(csvCell('a=b')).toBe('a=b')
    expect(csvCell('clients-2026')).toBe('clients-2026')
  })
})

describe('toCsv', () => {
  it('separates records with CRLF and ends with one', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['c,d', null],
      ]),
    ).toBe('a,b\r\n"c,d",\r\n')
  })
})
