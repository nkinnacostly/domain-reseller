import { describe, expect, it, vi } from 'vitest'
import type { CurrentTld, Listing, RawTld, TldRow } from './catalogue'
import type { CatalogueStore } from './store'
import { summarise, syncCatalogue } from './sync'

/**
 * One sync, as both the CLI and the gateway run it. The failure paths come
 * first: nothing is written from a listing that cannot be trusted, and
 * nothing is written without --apply.
 */

const YEARS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/** Priced the same every year, 1 to 10, as most of the production listing is. */
const tld = (name: string, register = 10): RawTld => ({
  name,
  prices: [
    {
      register: YEARS.map((period) => ({ period, price: register * period, currency: 'USD' })),
      renew: YEARS.map((period) => ({ period, price: register * period, currency: 'USD' })),
      transfer: [{ period: 1, price: register, currency: 'USD' }],
    },
  ],
  attributes: [],
})

/** A row synced before migration 37: no periods listed, so every year from 1 to 10. */
const stored = (name: string, register = 10): CurrentTld => ({
  name,
  register_usd: register,
  renew_usd: register,
  transfer_usd: register,
  restore_usd: null,
  min_period: 1,
  max_period: 10,
  register_periods: null,
  renew_periods: null,
  redemption_days: 0,
  requires_extra_fields: false,
  min_chars: null,
  max_chars: null,
  is_transferable: true,
  is_sellable: true,
})

const listing = (...items: RawTld[]): Listing => ({ items, total: items.length })

function fakeStore(table: CurrentTld[]) {
  return {
    load: vi.fn(async () => table),
    upsert: vi.fn(async (_rows: TldRow[], _syncedAt: string) => {}),
    retire: vi.fn(async (_names: string[]) => {}),
  } satisfies CatalogueStore
}

const NOW = new Date('2026-09-28T06:00:00Z')
const sync = (found: Listing, store: CatalogueStore, apply = true) =>
  syncCatalogue({ source: async () => found, store, apply, now: () => NOW })

describe('syncCatalogue', () => {
  it('refuses a short read before looking at the table, and writes nothing', async () => {
    const store = fakeStore([stored('com')])
    const result = await sync({ items: [tld('com')], total: 700 }, store)
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'The supplier said 700 extensions and listed 1',
      diff: null,
      report: ['The supplier said 700 extensions and listed 1'],
    })
    expect(store.load).not.toHaveBeenCalled()
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('refuses to retire a large part of the catalogue at once, and writes nothing', async () => {
    const table = Array.from({ length: 40 }, (_, i) => stored(`t${i}`))
    const store = fakeStore(table)
    const result = await sync(listing(tld('t0')), store)
    expect(result.outcome).toBe('refused')
    expect(result.reason).toBe('Would stop selling 39 of 40 extensions at once (limit 25)')
    expect(result.report.at(-1)).toBe(
      'Refused: Would stop selling 39 of 40 extensions at once (limit 25). Nothing written.',
    )
    expect(store.upsert).not.toHaveBeenCalled()
    expect(store.retire).not.toHaveBeenCalled()
  })

  it('passes a supplier or database failure on', async () => {
    const store = fakeStore([])
    store.load.mockRejectedValueOnce(new Error('Could not read the current catalogue: down'))
    await expect(sync(listing(tld('com')), store)).rejects.toThrow('down')
    await expect(
      syncCatalogue({
        source: async () => {
          throw new Error('HTTP 403: ')
        },
        store,
        apply: true,
      }),
    ).rejects.toThrow('HTTP 403')
  })

  it('reports changes without writing them unless asked to apply', async () => {
    const store = fakeStore([stored('com', 9)])
    const result = await sync(listing(tld('com')), store, false)
    expect(result.outcome).toBe('changes')
    expect(result.report.at(-1)).toBe('Report only. Re-run with --apply to write.')
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('writes nothing when the table is up to date', async () => {
    const store = fakeStore([stored('com')])
    const result = await sync(listing(tld('com')), store)
    expect(result.outcome).toBe('unchanged')
    expect(result.report.at(-1)).toBe('Catalogue is up to date.')
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('writes every listed extension and retires the ones that went away', async () => {
    const store = fakeStore([stored('com', 9), stored('gone')])
    const result = await sync(listing(tld('com'), tld('net')), store)
    expect(result.outcome).toBe('written')
    expect(store.upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({ name: 'com', register_usd: 10 }),
        expect.objectContaining({ name: 'net' }),
      ],
      '2026-09-28T06:00:00.000Z',
    )
    expect(store.retire).toHaveBeenCalledWith(['gone'])
    expect(result.report.at(-1)).toBe('Written. 2 extensions now priced from the live catalogue.')
    expect(summarise(result)).toEqual({
      listed: 2,
      sellable: 2,
      added: 1,
      retired: 1,
      priceChanges: 1,
      otherChanges: 0,
    })
  })

  it('adds an extension sold only in blocks with the periods it can be bought for, and says so', async () => {
    const ai: RawTld = {
      name: 'ai',
      minRegistrationPeriod: 2,
      maxRegistrationPeriod: 10,
      registrationPeriods: [2, 4, 6, 8, 10],
      renewalPeriods: [2, 4, 6, 8, 10],
      prices: [
        {
          register: [2, 4, 6, 8, 10].map((period) => ({ period, price: 99.9 * period })),
          renew: [2, 3, 4, 5].map((period) => ({
            period,
            price: period % 2 ? 999 : 99.9 * period,
          })),
          transfer: [{ period: 1, price: 99.9 }],
        },
      ],
    }
    const store = fakeStore([stored('com')])
    const result = await sync(listing(tld('com'), ai), store, false)
    expect(result.outcome).toBe('changes')
    expect(result.diff?.added).toEqual([
      expect.objectContaining({
        name: 'ai',
        register_usd: 99.9,
        min_period: 2,
        register_periods: [2, 4, 6, 8, 10],
        renew_periods: [2, 4],
      }),
    ])
    const text = result.report.join('\n')
    expect(text).toContain('.ai              register 2 4 6 8 10 · renew 2 4')
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('retires nothing when nothing went away', async () => {
    const store = fakeStore([stored('com', 9)])
    await sync(listing(tld('com')), store)
    expect(store.retire).not.toHaveBeenCalled()
  })

  it('stamps the write with the time it was made by default', async () => {
    const store = fakeStore([])
    await syncCatalogue({ source: async () => listing(tld('com')), store, apply: true })
    const stamp = store.upsert.mock.calls[0]?.[1] ?? ''
    expect(Date.now() - Date.parse(stamp)).toBeLessThan(5_000)
  })

  it('summarises a refused listing with what it could count', async () => {
    const result = await sync({ items: [tld('com')], total: 2 }, fakeStore([]))
    expect(summarise(result)).toEqual({
      listed: 1,
      sellable: 1,
      added: 0,
      retired: 0,
      priceChanges: 0,
      otherChanges: 0,
    })
  })
})
