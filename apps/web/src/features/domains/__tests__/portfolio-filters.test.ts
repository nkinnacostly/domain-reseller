import { describe, expect, it } from 'vitest'
import { chunk, IDS_PER_READ } from '../lib/chunks'
import {
  filterPortfolio,
  PAGE_SIZE,
  type PortfolioDomain,
  pageNumbers,
  paginate,
  parsePage,
  portfolioHref,
} from '../lib/portfolio'

const NOW = new Date('2026-09-24T09:00:00Z')
const ACME = { id: 'label-acme', name: 'Acme', color: 'blue' as const }
const BANKS = { id: 'label-banks', name: 'Banks', color: 'green' as const }

function domain(name: string, overrides: Partial<PortfolioDomain> = {}): PortfolioDomain {
  return {
    id: name,
    domainName: name,
    tld: 'com',
    source: 'registration',
    testMode: false,
    status: 'active',
    expiresAt: new Date(NOW.getTime() + 100 * 86_400_000).toISOString(),
    autoRenew: true,
    privacyEnabled: false,
    transferLock: true,
    delegationStatus: 'verified',
    nameservers: null,
    pendingNameservers: null,
    labels: [],
    ...overrides,
  }
}

const ALL = [
  domain('acme.com', { labels: [ACME] }),
  domain('both.com', { labels: [ACME, BANKS] }),
  domain('bank.ng', { labels: [BANKS] }),
  domain('plain.com'),
]

describe('filterPortfolio by label (FR-P3)', () => {
  it('keeps only the domains carrying the label, several labels to a domain', () => {
    const names = (list: PortfolioDomain[]) => list.map((entry) => entry.domainName)
    expect(names(filterPortfolio(ALL, { labelId: ACME.id }, NOW))).toEqual(['acme.com', 'both.com'])
    expect(names(filterPortfolio(ALL, { labelId: BANKS.id }, NOW))).toEqual(['bank.ng', 'both.com'])
  })

  it('combines with the search', () => {
    expect(
      filterPortfolio(ALL, { labelId: ACME.id, query: 'both' }, NOW).map((entry) => entry.id),
    ).toEqual(['both.com'])
  })

  it('filters nothing out without a label', () => {
    expect(filterPortfolio(ALL, { labelId: null }, NOW)).toHaveLength(4)
  })
})

describe('portfolioHref', () => {
  it('keeps every filter, in a stable order', () => {
    expect(portfolioHref({})).toBe('/app/domains')
    expect(portfolioHref({ labelId: 'label-acme' })).toBe('/app/domains?label=label-acme')
    expect(portfolioHref({ query: 'acme', within: 30, labelId: 'label-acme' })).toBe(
      '/app/domains?q=acme&within=30&label=label-acme',
    )
    expect(portfolioHref({ query: '', within: null, labelId: null })).toBe('/app/domains')
  })

  it('keeps a page past the first, after the filters, and leaves page 1 out', () => {
    expect(portfolioHref({ query: 'acme', page: 3 })).toBe('/app/domains?q=acme&page=3')
    expect(portfolioHref({ page: 1 })).toBe('/app/domains')
  })
})

describe('paginate', () => {
  const rows = Array.from({ length: 60 }, (_, index) => index + 1)

  it('shows a page of rows and says which ones', () => {
    expect(paginate(rows, 2)).toEqual({
      items: rows.slice(PAGE_SIZE, 2 * PAGE_SIZE),
      page: 2,
      pageCount: 3,
      from: 26,
      to: 50,
      total: 60,
    })
    expect(paginate(rows, 3)).toMatchObject({ from: 51, to: 60 })
  })

  it('shows the last page for a page past the end, and the first for one before it', () => {
    expect(paginate(rows, 40)).toMatchObject({ page: 3, from: 51, to: 60 })
    expect(paginate(rows, 0)).toMatchObject({ page: 1, from: 1, to: 25 })
  })

  it('has one empty page for nothing', () => {
    expect(paginate([], 4)).toEqual({ items: [], page: 1, pageCount: 1, from: 0, to: 0, total: 0 })
  })
})

describe('parsePage', () => {
  it('reads a whole page number, and anything else as page 1', () => {
    expect(parsePage('3')).toBe(3)
    for (const value of [undefined, '', '0', '-2', '1.5', 'two', '1e400']) {
      expect(parsePage(value)).toBe(1)
    }
  })
})

describe('pageNumbers', () => {
  it('offers every page up to seven', () => {
    expect(pageNumbers(1, 1)).toEqual([1])
    expect(pageNumbers(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps the ends and the current page’s neighbours, with a gap for the rest', () => {
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, 4, 5, 'gap-end', 20])
    expect(pageNumbers(10, 20)).toEqual([1, 'gap-start', 9, 10, 11, 'gap-end', 20])
    expect(pageNumbers(20, 20)).toEqual([1, 'gap-start', 16, 17, 18, 19, 20])
  })

  it('shows a lone left-out page rather than a gap standing for it', () => {
    expect(pageNumbers(4, 10)).toEqual([1, 2, 3, 4, 5, 'gap-end', 10])
    expect(pageNumbers(7, 10)).toEqual([1, 'gap-start', 6, 7, 8, 9, 10])
  })
})

describe('chunk — bulk reads by id in runs', () => {
  it('splits into runs of at most the size, keeping order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
    expect(
      chunk(
        Array.from({ length: 500 }, (_, index) => index),
        IDS_PER_READ,
      ),
    ).toHaveLength(5)
  })

  it('refuses a size that could never end', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError)
  })
})
