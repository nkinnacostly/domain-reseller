import { describe, expect, it } from 'vitest'
import {
  MARGIN_CSV_HEADER,
  marginCsv,
  moneyCell,
  moneyCsvName,
  naira,
  REVENUE_CSV_HEADER,
  revenueCsv,
  toMoneyCsv,
  whole,
} from '@/features/admin/lib/money-csv'
import { marginSummary, parseRevenue } from '@/features/admin/lib/money-data'
import { marginAnswer, revenueAnswer } from './fixtures'

const lines = (csv: string) => csv.split('\r\n').filter(Boolean)

describe('the formula guard (CLAUDE.md §15 "CSV export guards against formulas")', () => {
  it('turns text a spreadsheet would run into text it shows', () => {
    expect(moneyCell('=HYPERLINK("http://evil.test","x")')).toBe(
      `"'=HYPERLINK(""http://evil.test"",""x"")"`,
    )
    expect(moneyCell('+1+1')).toBe("'+1+1")
    expect(moneyCell('-2+3')).toBe("'-2+3")
    expect(moneyCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(moneyCell('\tcmd')).toBe(`'\tcmd`)
  })

  it('writes a figure as a plain number, so a negative margin still adds up', () => {
    expect(moneyCell(naira(-1_700_000))).toBe('-17000.00')
    expect(moneyCell(whole(12))).toBe('12')
  })

  it('guards anything posing as a figure that is not a plain number', () => {
    expect(moneyCell({ figure: '-2+3' })).toBe("'-2+3")
    expect(moneyCell({ figure: '=1' })).toBe("'=1")
  })

  it('quotes by RFC 4180 and leaves an unknown figure empty', () => {
    expect(moneyCell("DomainNameAPI's ledger, matched")).toBe(`"DomainNameAPI's ledger, matched"`)
    expect(moneyCell(null)).toBe('')
    expect(toMoneyCsv([['a', null, whole(1)]])).toBe('a,,1\r\n')
  })
})

describe('naira from kobo (N5)', () => {
  it('uses whole-number arithmetic, never a float', () => {
    expect(naira(0)).toEqual({ figure: '0.00' })
    expect(naira(5)).toEqual({ figure: '0.05' })
    expect(naira(123_456)).toEqual({ figure: '1234.56' })
    expect(naira(-99)).toEqual({ figure: '-0.99' })
    expect(naira(900_719_925_474_099)).toEqual({ figure: '9007199254740.99' })
  })

  it('refuses a figure that is not whole kobo', () => {
    expect(() => naira(10.5)).toThrow('whole kobo')
    expect(() => whole(1.5)).toThrow('whole number')
  })
})

describe('the sales file', () => {
  it('has every bucket, empty ones too, with the side, the days and VAT in each heading', () => {
    const parsed = parseRevenue(revenueAnswer())
    if ('issues' in parsed) throw new Error('unparsed')
    const csv = revenueCsv(
      parsed.rows,
      { from: '2026-10-01', to: '2026-10-03', grain: 'day' },
      'test',
    )
    const [header, ...rows] = lines(csv)
    expect(header).toBe(REVENUE_CSV_HEADER.join(','))
    expect(header).toMatch(/,Net sales excluding VAT \(NGN\),/)
    expect(header).toMatch(/,Cash in including VAT \(NGN\),/)
    expect(rows).toEqual([
      'Test,2026-10-01,2026-10-01,2,20000.00,1500.00,21500.00,0.00,0.00,0.00,301.00,301.00',
      'Test,2026-10-02,2026-10-02,0,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00',
      'Test,2026-10-03,2026-10-03,1,10000.00,750.00,21500.00,10000.00,750.00,10750.00,150.50,0.00',
    ])
  })

  it('gives a cut week the days inside the dates', () => {
    const parsed = parseRevenue([revenueAnswer()[0]])
    if ('issues' in parsed) throw new Error('unparsed')
    const csv = revenueCsv(
      [{ ...(parsed.rows[0] as (typeof parsed.rows)[number]), bucket: '2026-09-28' }],
      { from: '2026-10-01', to: '2026-10-03', grain: 'week' },
      'live',
    )
    expect(lines(csv)[1]).toMatch(/^Live,2026-10-01,2026-10-03,/)
  })
})

describe('the margin file', () => {
  it('holds each sold group, the lost row and the total over known costs', () => {
    const csv = marginCsv(
      marginSummary(marginAnswer()),
      { from: '2026-09-01', to: '2026-10-03' },
      'live',
    )
    const [header, ...rows] = lines(csv)
    expect(header).toBe(MARGIN_CSV_HEADER.join(','))
    expect(rows).toEqual([
      `Live,2026-09-01,2026-10-03,Registrations,3,3,60000.00,51000.00,9000.00,DomainNameAPI's ledger,`,
      'Live,2026-09-01,2026-10-03,Registrations,2,0,38000.00,,,Not costed,',
      'Live,2026-09-01,2026-10-03,Renewals,1,1,19000.00,16500.00,2500.00,Recorded at checkout,',
      `Live,2026-09-01,2026-10-03,Supplier cost on failed or refunded lines,1,1,0.00,17000.00,-17000.00,DomainNameAPI's ledger,`,
      'Live,2026-09-01,2026-10-03,"Total, lines with a known cost",5,5,79000.00,84500.00,-5500.00,,',
    ])
  })

  it('names files by what, which side, which dates and which grain', () => {
    const params = { from: '2026-09-03', to: '2026-10-03', grain: 'day' as const }
    expect(moneyCsvName('sales', params, 'test')).toBe(
      'money-sales-test-2026-09-03-to-2026-10-03-by-day.csv',
    )
    expect(moneyCsvName('margin', params, 'live')).toBe(
      'money-margin-live-2026-09-03-to-2026-10-03.csv',
    )
  })
})
