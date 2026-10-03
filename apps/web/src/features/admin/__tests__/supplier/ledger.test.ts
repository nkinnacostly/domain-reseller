import { describe, expect, it } from 'vitest'
import {
  type ChainEntry,
  checkChain,
  formatDelta,
  isFiltered,
  kindLabel,
  lagosRange,
  ledgerHref,
  matchLabel,
  parseLedgerSearch,
  revisionLines,
  STRIP_LENGTH,
  stripWords,
} from '@/features/admin/lib/supplier-ledger'

describe('the ledger’s address (§5.2, the cross-page link contract)', () => {
  it('opens on unexplained charges from the overview', () => {
    const params = parseLedgerSearch({ status: 'unexplained' })
    expect(params.status).toEqual(['unexplained'])
    expect(params.sort).toBe('occurred')
    expect(params.dir).toBe('desc')
  })

  it('falls back to the whole list for a status it does not know', () => {
    expect(parseLedgerSearch({ status: 'all-of-them' }).status).toEqual([])
    expect(parseLedgerSearch({ status: 'unexplained,bogus,matched' }).status).toEqual([
      'unexplained',
      'matched',
    ])
  })

  it('takes one trace from an alert, lower-cased, and drops anything that is not a GUID', () => {
    expect(parseLedgerSearch({ trace: '0F1E2D3C-4B5A-B697-7887-A1B2C3D4E5F6' }).trace).toBe(
      '0f1e2d3c-4b5a-b697-7887-a1b2c3d4e5f6',
    )
    expect(parseLedgerSearch({ trace: 'example.com' }).trace).toBeNull()
    expect(parseLedgerSearch({ trace: ['0f1e2d3c-4b5a-b697-7887-a1b2c3d4e5f6', 'x'] }).trace).toBe(
      '0f1e2d3c-4b5a-b697-7887-a1b2c3d4e5f6',
    )
  })

  it('builds links from parsed values: a filter goes back to page 1 and keeps the trace', () => {
    const params = parseLedgerSearch({
      status: 'matched',
      page: '3',
      trace: '0f1e2d3c-4b5a-b697-7887-a1b2c3d4e5f6',
    })
    expect(ledgerHref(params, { page: 4 })).toBe(
      '/admin/supplier/ledger?status=matched&page=4&trace=0f1e2d3c-4b5a-b697-7887-a1b2c3d4e5f6',
    )
    expect(ledgerHref(params, { status: ['unexplained'] })).toBe(
      '/admin/supplier/ledger?status=unexplained&trace=0f1e2d3c-4b5a-b697-7887-a1b2c3d4e5f6',
    )
    expect(ledgerHref(params, { trace: null })).toBe('/admin/supplier/ledger?status=matched')
    expect(ledgerHref(parseLedgerSearch({}))).toBe('/admin/supplier/ledger')
  })

  it('knows when anything narrows the list', () => {
    expect(isFiltered(parseLedgerSearch({}))).toBe(false)
    expect(isFiltered(parseLedgerSearch({ from: '2026-10-01' }))).toBe(true)
    expect(isFiltered(parseLedgerSearch({ status: 'topup' }))).toBe(true)
  })

  it('turns Lagos days into instants: midnight WAT is 23:00 UTC the day before', () => {
    expect(lagosRange('2026-10-01', '2026-10-03')).toEqual({
      gte: '2026-09-30T23:00:00.000Z',
      lt: '2026-10-03T23:00:00.000Z',
    })
    expect(lagosRange(null, null)).toEqual({ gte: null, lt: null })
    expect(lagosRange(null, '2026-12-31').lt).toBe('2026-12-31T23:00:00.000Z')
  })
})

describe('match labels (§7)', () => {
  it('names what a matched debit bought', () => {
    const matched = (op: string | null) =>
      matchLabel({ matchState: 'matched', matchOperation: op, status: 1 })
    expect(matched('RegisterWithContactInfo')).toBe('Matched to a registration')
    expect(matched('Renew')).toBe('Matched to a renewal')
    expect(matched('Transfer')).toBe('Matched to a transfer in')
    expect(matched('SslInitialize')).toBe('Matched to a certificate order')
    expect(matched('SslReissue')).toBe('Matched to a certificate reissue')
    expect(matched('SomethingNew')).toBe('Matched to SomethingNew')
    expect(matched(null)).toBe('Matched to an order')
  })

  it('says what needs a person, and why an entry is not counted', () => {
    const label = (matchState: string, status = 1) =>
      matchLabel({ matchState, matchOperation: null, status })
    expect(label('topup')).toBe('A top-up of our float')
    expect(label('pending')).toMatch(/^Waiting to match/)
    expect(label('unexplained')).toBe(
      'No matching provisioning call: supplier panel use, a leaked key, or a supplier-side change',
    )
    expect(label('unclassified')).toBe('Not a shape we classify: shown as read, never counted')
    expect(label('unclassified', 0)).toBe(
      'Not settled at DomainNameAPI (status 0): shown as read, never counted',
    )
    expect(label('something_else')).toBe('something else')
  })
})

describe('kind labels (§4.3 LedgerKind)', () => {
  it('names the three shapes seen live, and shows anything else raw', () => {
    expect(kindLabel({ type: 5, status: 1, chargeType: 0, productType: 3 })).toBe('Top-up')
    expect(kindLabel({ type: 2, status: 1, chargeType: 1, productType: 1 })).toBe('Domain charge')
    expect(kindLabel({ type: 2, status: 1, chargeType: 1, productType: 2 })).toBe(
      'Certificate charge',
    )
    expect(kindLabel({ type: 2, status: 0, chargeType: 1, productType: 1 })).toBe(
      'Unclassified (type 2, charge 1, product 1, status 0)',
    )
  })

  it('signs a change: a credit with a plus, a debit with a minus', () => {
    expect(formatDelta(3600)).toBe('+$36.00')
    expect(formatDelta(-1131)).toBe('−$11.31')
    expect(formatDelta(0)).toBe('$0.00')
  })
})

describe('the balance chain (§7.5)', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString()
  /** The live chain from §7.5: 0 → 15 → 3.69 → 18.69 → 7.38 → 43.38. */
  const live: ChainEntry[] = [
    {
      traceId: 'a',
      occurredAt: at(0),
      description: 'Ziraat Payment',
      oldBalanceCents: 0,
      balanceCents: 1500,
    },
    {
      traceId: 'b',
      occurredAt: at(1),
      description: 'one.com',
      oldBalanceCents: 1500,
      balanceCents: 369,
    },
    {
      traceId: 'c',
      occurredAt: at(2),
      description: 'Ziraat Payment',
      oldBalanceCents: 369,
      balanceCents: 1869,
    },
    {
      traceId: 'd',
      occurredAt: at(3),
      description: 'two.com',
      oldBalanceCents: 1869,
      balanceCents: 738,
    },
    {
      traceId: 'e',
      occurredAt: at(4),
      description: 'Ziraat Payment',
      oldBalanceCents: 738,
      balanceCents: 4338,
    },
  ]

  it('agrees when every entry starts where the one before ended, whatever order SQL sends', () => {
    const chain = checkChain([...live].reverse(), 'live')
    expect(chain).toMatchObject({ count: 5, breaks: [], lastCents: 4338 })
    expect(chain.strip).toEqual([0, 1500, 369, 1869, 738, 4338])
    expect(stripWords(chain.strip)).toBe('0.00 → 15.00 → 3.69 → 18.69 → 7.38 → 43.38')
  })

  it('names a break: where the entry started, and where the one before ended', () => {
    const broken = live.map((entry) =>
      entry.traceId === 'd' ? { ...entry, oldBalanceCents: 1800 } : entry,
    )
    const chain = checkChain(broken, 'live')
    expect(chain.breaks).toEqual([
      { traceId: 'd', occurredAt: at(3), expectedCents: 1869, foundCents: 1800 },
    ])
    expect(chain.strip).toHaveLength(STRIP_LENGTH)
    expect(chain.strip.slice(-3)).toEqual([1800, 738, 4338])
  })

  it('orders entries at the same instant by trace id, as SQL does', () => {
    const same = [
      { ...live[1], traceId: 'z', occurredAt: at(0) } as ChainEntry,
      { ...live[0], traceId: 'y', occurredAt: at(0) } as ChainEntry,
    ]
    expect(checkChain(same, 'live').breaks).toEqual([])
  })

  it('leaves e2e rows out on the test side only, as SQL leaves them out of its checks', () => {
    const seeded: ChainEntry = {
      traceId: 'x',
      occurredAt: at(5),
      description: 'e2e-debit.com',
      oldBalanceCents: 100_000,
      balanceCents: 98_869,
    }
    expect(checkChain([...live, seeded], 'test')).toMatchObject({ count: 5, breaks: [] })
    expect(checkChain([...live, seeded], 'live').breaks).toHaveLength(1)
  })

  it('is empty with no entries', () => {
    expect(checkChain([], 'live')).toEqual({ count: 0, breaks: [], strip: [], lastCents: null })
  })
})

describe('revision lines (§3.2a)', () => {
  it('shows each changed fact as stored → read, by name', () => {
    expect(
      revisionLines({
        status: { stored: 0, read: 1 },
        description: { stored: 'a.com', read: 'b.com' },
        period: { stored: null, read: 1 },
      }),
    ).toEqual(['description: a.com → b.com', 'period: (none) → 1', 'status: 0 → 1'])
  })

  it('never drops a change it cannot read', () => {
    expect(revisionLines({ balance_cents: 'odd' })).toEqual(['balance cents: changed'])
    expect(revisionLines({ product_id: { stored: { a: 1 }, read: '' } })).toEqual([
      'product id: {"a":1} → (none)',
    ])
    expect(revisionLines(null)).toEqual([])
    expect(revisionLines(['x'])).toEqual([])
  })
})
