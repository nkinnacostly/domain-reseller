import { describe, expect, it } from 'vitest'
import type { ResultRow } from '../lib/bulk-run'
import {
  CSV_HEADER,
  csvCell,
  describeCsvRead,
  joinWords,
  nairaFigure,
  parseCsv,
  readNamesFromCsv,
  resultsCsv,
} from '../lib/csv'

const BOM = String.fromCharCode(0xfeff)

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes and line breaks inside quotes', () => {
    expect(parseCsv('a,"b, c","say ""hi""","two\nlines"\r\nnext,row')).toEqual([
      ['a', 'b, c', 'say "hi"', 'two\nlines'],
      ['next', 'row'],
    ])
  })

  it('ignores the byte order mark and the line break at the end of the file', () => {
    expect(parseCsv(`${BOM}domain\ngetpaid.com\n`)).toEqual([['domain'], ['getpaid.com']])
  })

  it('reads files split by semicolons or tabs, the way some spreadsheets save them', () => {
    expect(parseCsv('domain;price\ngetpaid.com;10')).toEqual([
      ['domain', 'price'],
      ['getpaid.com', '10'],
    ])
    expect(parseCsv('domain\tprice\ngetpaid.com\t10')).toEqual([
      ['domain', 'price'],
      ['getpaid.com', '10'],
    ])
  })

  it('keeps old Mac line endings apart', () => {
    expect(parseCsv('a\rb')).toEqual([['a'], ['b']])
  })

  it('reads an empty file as no rows', () => {
    expect(parseCsv('')).toEqual([])
  })
})

describe('readNamesFromCsv', () => {
  it('uses the column headed domain, wherever it is', () => {
    const read = readNamesFromCsv('client,Domain,notes\nAda,getpaid.com,x\nBola,mybrand.africa,y')
    expect(read).toEqual({
      names: ['getpaid.com', 'mybrand.africa'],
      column: 'Domain',
      blank: 0,
      duplicates: 0,
      unusable: 0,
    })
  })

  it('uses a column headed name when there is no domain column', () => {
    expect(readNamesFromCsv('id,name\n1,getpaid\n2,other').names).toEqual(['getpaid', 'other'])
  })

  it('uses the first column, first row included, when there is no header it knows', () => {
    const read = readNamesFromCsv('getpaid.com,10\nother.net,12')
    expect(read.column).toBeNull()
    expect(read.names).toEqual(['getpaid.com', 'other.net'])
  })

  it('skips blank rows, repeats and cells no domain could be, and counts each', () => {
    const read = readNamesFromCsv(
      'domain\ngetpaid.com\n\nGETPAID.COM\n"my brand"\n  \nother.net\n"a,b"\n',
    )
    expect(read).toMatchObject({
      names: ['getpaid.com', 'other.net'],
      blank: 2,
      duplicates: 1,
      unusable: 2,
    })
  })

  it('counts a short row as blank in the names column', () => {
    expect(readNamesFromCsv('id,domain\n1\n2,getpaid.com')).toMatchObject({
      names: ['getpaid.com'],
      blank: 1,
    })
  })
})

describe('describeCsvRead — what the page says after reading a file', () => {
  it('says how many names came from which column', () => {
    expect(
      describeCsvRead('brands.csv', {
        names: ['a', 'b'],
        column: 'domain',
        blank: 0,
        duplicates: 0,
        unusable: 0,
      }),
    ).toBe('Read 2 names from the “domain” column of brands.csv.')
    expect(
      describeCsvRead('list.csv', {
        names: ['a'],
        column: null,
        blank: 0,
        duplicates: 0,
        unusable: 0,
      }),
    ).toBe('Read 1 name from the first column of list.csv.')
  })

  it('says why rows were left out', () => {
    expect(
      describeCsvRead('brands.csv', {
        names: Array.from({ length: 1_200 }, () => 'x'),
        column: null,
        blank: 1,
        duplicates: 3,
        unusable: 1,
      }),
    ).toBe(
      'Read 1,200 names from the first column of brands.csv. Left out 1 blank row, 3 repeats and 1 entry with a space or comma in it, which no domain name has.',
    )
    expect(
      describeCsvRead('b.csv', {
        names: ['a'],
        column: null,
        blank: 2,
        duplicates: 0,
        unusable: 2,
      }),
    ).toMatch(/Left out 2 blank rows and 2 entries with a space or comma in them/)
  })
})

describe('joinWords', () => {
  it('reads as a sentence', () => {
    expect(joinWords([])).toBe('')
    expect(joinWords(['a'])).toBe('a')
    expect(joinWords(['a', 'b'])).toBe('a and b')
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c')
  })
})

describe('csvCell', () => {
  it('quotes a cell with a comma, a quote or a line break', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
  })

  it('keeps a cell that would run as a spreadsheet formula as text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-x')).toBe("'-x")
    expect(csvCell('@sum')).toBe("'@sum")
  })
})

describe('nairaFigure', () => {
  it('writes kobo as naira without floating-point drift (N5)', () => {
    expect(nairaFigure(1_820_000)).toBe('18200.00')
    expect(nairaFigure(1_820_050)).toBe('18200.50')
    expect(nairaFigure(7)).toBe('0.07')
  })
})

describe('resultsCsv — the export (FR-S5, N8)', () => {
  const row = (overrides: Partial<ResultRow>): ResultRow => ({
    key: 'k',
    order: 0,
    display: 'getpaid.com',
    domain: 'getpaid.com',
    name: 'getpaid',
    tld: 'com',
    category: 'available',
    status: 'available',
    label: null,
    note: null,
    price: null,
    ...overrides,
  })

  it('writes every row with its status and, when free, both prices', () => {
    const csv = resultsCsv([
      row({
        price: {
          register: '₦18,200',
          renew: '₦19,000',
          renewalIsHigher: true,
          includesIcannFee: true,
          maxPeriod: 10,
          registerKobo: 1_820_000,
          renewKobo: 1_900_000,
        },
      }),
      row({ display: 'takenbrand.com', domain: 'takenbrand.com', category: 'taken' }),
      row({ display: 'café.com', domain: 'xn--caf-dma.com', category: 'unchecked' }),
      row({
        display: 'mid.xn--p1ai',
        domain: 'mid.xn--p1ai',
        tld: 'xn--p1ai',
        category: 'premium',
      }),
      row({
        display: '=not a name',
        domain: null,
        name: null,
        tld: null,
        category: 'refused',
        label: 'Not a domain',
      }),
    ])

    expect(csv.startsWith(BOM)).toBe(true)
    expect(csv.slice(1).split('\r\n')).toEqual([
      CSV_HEADER.join(','),
      'getpaid.com,com,available,18200.00,19000.00,getpaid.com',
      'takenbrand.com,com,taken,,,takenbrand.com',
      'café.com,com,not checked,,,xn--caf-dma.com',
      'mid.xn--p1ai,рф,premium,,,mid.xn--p1ai',
      "'=not a name,,not a domain,,,",
      '',
    ])
  })
})
