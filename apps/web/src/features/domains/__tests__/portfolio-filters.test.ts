import { describe, expect, it } from 'vitest'
import { chunk, IDS_PER_READ } from '../lib/chunks'
import { filterPortfolio, type PortfolioDomain, portfolioHref } from '../lib/portfolio'

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
