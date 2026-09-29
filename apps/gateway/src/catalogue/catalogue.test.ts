import { describe, expect, it } from 'vitest'
import {
  type CurrentTld,
  charLimits,
  compareCatalogue,
  formatReport,
  hasChanges,
  listingRefusal,
  periodsOf,
  priceOf,
  type RawTld,
  requiresExtraFields,
  retirementRefusal,
  sellingTerms,
  type TldRow,
  termsNotes,
  toRow,
  toRows,
  transferability,
  yearsList,
} from './catalogue'

/**
 * The catalogue decides every wholesale cost on the storefront (N5b). What
 * matters: a price is read only when it is certainly a one-year dollar price,
 * nothing is invented where the supplier says nothing, and a listing that
 * looks broken is refused rather than written.
 */

const YEARS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const cents = (usd: number) => Math.round(usd * 100) / 100

/** .com's price list on 29 Sept 2026: the first year, then the renewal price each year. */
const prices = (over: Record<string, unknown[]> = {}) => [
  {
    priceGroup: 'Reseller',
    register: YEARS.map((period) => ({
      period,
      price: cents(11.31 + 11.51 * (period - 1)),
      currency: 'USD',
    })).reverse(),
    renew: YEARS.map((period) => ({ period, price: cents(11.51 * period), currency: 'USD' })),
    transfer: [{ period: 1, price: 11.51, currency: 'USD' }],
    restore: [{ period: 1, price: 80, currency: 'USD' }],
    ...over,
  },
]

/** An extension as the production listing gives it (24 and 29 Sept 2026). */
const raw = (over: Partial<RawTld> = {}): RawTld => ({
  name: 'com',
  minRegistrationPeriod: 1,
  maxRegistrationPeriod: 10,
  registrationPeriods: YEARS,
  renewalPeriods: YEARS,
  deletionRestorablePeriod: 30,
  prices: prices(),
  attributes: [],
  ...over,
})

/** .ai exactly as the supplier listed it on 29 Sept 2026. */
const AI: RawTld = {
  name: 'ai',
  minRegistrationPeriod: 2,
  maxRegistrationPeriod: 10,
  registrationPeriods: [2, 4, 6, 8, 10],
  renewalPeriods: [2, 4, 6, 8, 10],
  deletionRestorablePeriod: 30,
  prices: [
    {
      priceGroup: 'Reseller',
      register: [
        { period: 2, price: 199.8, currency: 'USD' },
        { period: 4, price: 399.6, currency: 'USD' },
        { period: 6, price: 599.4, currency: 'USD' },
        { period: 8, price: 799.2, currency: 'USD' },
        { period: 10, price: 999, currency: 'USD' },
      ],
      renew: [
        { period: 2, price: 199.8, currency: 'USD' },
        { period: 3, price: 599.4, currency: 'USD' },
        { period: 4, price: 399.6, currency: 'USD' },
        { period: 5, price: 999, currency: 'USD' },
        { period: 6, price: 599.4, currency: 'USD' },
        { period: 7, price: 1398.6, currency: 'USD' },
        { period: 8, price: 799.2, currency: 'USD' },
        { period: 9, price: 1798.2, currency: 'USD' },
        { period: 10, price: 999, currency: 'USD' },
      ],
      transfer: [{ period: 1, price: 99.9, currency: 'USD' }],
      restore: { period: 1, price: 209.95, currency: 'USD' },
    },
  ],
  attributes: [],
}

const row = (over: Partial<TldRow> = {}): TldRow => ({
  name: 'com',
  register_usd: 11.31,
  renew_usd: 11.51,
  transfer_usd: 11.51,
  restore_usd: 80,
  min_period: 1,
  max_period: 10,
  register_periods: YEARS,
  renew_periods: YEARS,
  redemption_days: 30,
  requires_extra_fields: false,
  min_chars: null,
  max_chars: null,
  is_transferable: true,
  is_sellable: true,
  ...over,
})

const current = (over: Partial<CurrentTld> = {}): CurrentTld => {
  const { is_sellable: _, ...base } = row()
  return { ...base, is_sellable: true, ...over }
}

describe('priceOf', () => {
  it('reads the one-year price of a kind', () => {
    expect(priceOf(raw(), 'register')).toBe(11.31)
    expect(priceOf(raw(), 'register', 2)).toBe(22.82)
  })

  it('refuses a price in any currency but dollars (the float is USD)', () => {
    const tld = raw({ prices: prices({ register: [{ period: 1, price: 350, currency: 'TRY' }] }) })
    expect(priceOf(tld, 'register')).toBeNull()
  })

  it('takes a price listed without a currency as dollars, as it always has been', () => {
    expect(priceOf(raw({ prices: prices({ renew: [{ period: 1, price: 9 }] }) }), 'renew')).toBe(9)
    expect(
      priceOf(
        raw({ prices: prices({ renew: [{ period: 1, price: 9, currency: 'usd' }] }) }),
        'renew',
      ),
    ).toBe(9)
  })

  it('ignores prices that are not a real amount', () => {
    for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY, '11.31', null]) {
      expect(
        priceOf(raw({ prices: prices({ register: [{ period: 1, price }] }) }), 'register'),
      ).toBeNull()
    }
  })

  it('rounds to the column’s four places, so a stored price never reads back as a change', () => {
    const tld = raw({ prices: prices({ register: [{ period: 1, price: 51.166_666 }] }) })
    expect(priceOf(tld, 'register')).toBe(51.1667)
  })

  it('finds nothing in a malformed price list', () => {
    expect(priceOf(raw({ prices: undefined }), 'register')).toBeNull()
    expect(
      priceOf(raw({ prices: ['x', { register: 'x' }, { register: [null, 'x'] }] }), 'register'),
    ).toBeNull()
  })
})

describe('requiresExtraFields', () => {
  it('counts only a required field, never a label or an optional one', () => {
    expect(requiresExtraFields(raw({ attributes: [{ type: 'Text', isRequired: true }] }))).toBe(
      true,
    )
    expect(requiresExtraFields(raw({ attributes: [{ type: 'Label', isRequired: true }] }))).toBe(
      false,
    )
    expect(requiresExtraFields(raw({ attributes: [{ type: 'Text', isRequired: false }] }))).toBe(
      false,
    )
    expect(requiresExtraFields(raw({ attributes: [null, 'x'] }))).toBe(false)
    expect(requiresExtraFields(raw({ attributes: undefined }))).toBe(false)
  })
})

describe('charLimits', () => {
  it('stores unknown, not the SDK’s 1 and 63, when the listing says nothing', () => {
    expect(charLimits(raw())).toEqual({ min_chars: null, max_chars: null })
  })

  it('reads the limits the SDK would read, including its misspelt key', () => {
    expect(charLimits(raw({ constraints: { minLength: 3, maxLenght: 63 } }))).toEqual({
      min_chars: 3,
      max_chars: 63,
    })
    expect(charLimits(raw({ constraints: { minLength: 2, maxLength: 40 } }))).toEqual({
      min_chars: 2,
      max_chars: 40,
    })
  })

  it('drops a limit DNS could not have', () => {
    expect(charLimits(raw({ constraints: { minLength: 0, maxLength: 64 } }))).toEqual({
      min_chars: null,
      max_chars: null,
    })
    expect(charLimits(raw({ constraints: { minLength: '3', maxLength: 2.5 } }))).toEqual({
      min_chars: null,
      max_chars: null,
    })
  })

  it('drops both when they contradict each other', () => {
    expect(charLimits(raw({ constraints: { minLength: 10, maxLength: 5 } }))).toEqual({
      min_chars: null,
      max_chars: null,
    })
  })
})

describe('transferability', () => {
  it('is yes when the supplier sells a transfer', () => {
    expect(transferability(raw())).toBe(true)
  })

  it('is no when the supplier lists no transfer at all', () => {
    expect(transferability(raw({ prices: prices({ transfer: [] }) }))).toBe(false)
    const { transfer: _, ...withoutTransfer } = prices()[0]!
    expect(transferability(raw({ prices: [withoutTransfer] }))).toBe(false)
    expect(transferability(raw({ prices: ['x', null] }))).toBe(false)
    expect(transferability(raw({ prices: undefined }))).toBe(false)
  })

  it('is unknown for a transfer listed at $0 (.uk, .ch, .ng) or only for other periods', () => {
    expect(
      transferability(
        raw({ prices: prices({ transfer: [{ period: 1, price: 0, currency: 'USD' }] }) }),
      ),
    ).toBeNull()
    expect(
      transferability(raw({ prices: prices({ transfer: [{ period: 2, price: 20 }] }) })),
    ).toBeNull()
  })
})

describe('toRow', () => {
  it('builds the row the table holds', () => {
    expect(toRow(raw())).toEqual(row())
  })

  it('refuses an extension it cannot price or name', () => {
    expect(toRow(raw({ prices: prices({ register: [] }) }))).toBeNull()
    expect(toRow(raw({ prices: prices({ register: [{ period: 1, price: 0 }] }) }))).toBeNull()
    expect(toRow(raw({ name: '  ' }))).toBeNull()
    expect(toRow(raw({ name: 42 }))).toBeNull()
  })

  it('does not sell an extension with no renewal price, rather than guess one (N8, N9b)', () => {
    expect(toRow(raw({ prices: prices({ renew: [] }) }))).toBeNull()
  })

  it('takes the periods from the price list when the listing’s own are unusable', () => {
    expect(
      toRow(
        raw({
          minRegistrationPeriod: 0,
          maxRegistrationPeriod: 'ten',
          registrationPeriods: 'all',
          renewalPeriods: null,
          deletionRestorablePeriod: -5,
        }),
      ),
    ).toMatchObject({
      min_period: 1,
      max_period: 10,
      register_periods: YEARS,
      renew_periods: YEARS,
      redemption_days: 0,
    })
  })

  it('stores .ai per year, with the two-year minimum and the blocks it is sold in', () => {
    expect(toRow(AI)).toEqual({
      name: 'ai',
      register_usd: 99.9,
      renew_usd: 99.9,
      transfer_usd: 99.9,
      // The listing gives restore as one object, not a list; it is not sold online.
      restore_usd: null,
      min_period: 2,
      max_period: 10,
      register_periods: [2, 4, 6, 8, 10],
      renew_periods: [2, 4, 6, 8, 10],
      redemption_days: 30,
      requires_extra_fields: false,
      min_chars: null,
      max_chars: null,
      is_transferable: true,
      is_sellable: true,
    })
  })
})

describe('sellingTerms', () => {
  it('sells a steady one-year extension every year, at its one-year prices, as before', () => {
    expect(sellingTerms(raw())).toEqual({
      ok: true,
      registerUsd: 11.31,
      renewUsd: 11.51,
      registerPeriods: YEARS,
      renewPeriods: YEARS,
      dropped: { register: [], renew: [] },
      unsold: { register: [], renew: [] },
    })
  })

  it('leaves out .ai’s odd renewal years: priced, but not periods the registry sells', () => {
    expect(sellingTerms(AI)).toEqual({
      ok: true,
      registerUsd: 99.9,
      renewUsd: 99.9,
      registerPeriods: [2, 4, 6, 8, 10],
      renewPeriods: [2, 4, 6, 8, 10],
      dropped: { register: [], renew: [] },
      unsold: { register: [], renew: [3, 5, 7, 9] },
    })
  })

  it('drops a listed period whose price is not the per-year rate times its years', () => {
    // Were the odd years sold, their prices would still rule them out.
    expect(sellingTerms({ ...AI, renewalPeriods: YEARS })).toMatchObject({
      ok: true,
      renewPeriods: [2, 4, 6, 8, 10],
      dropped: { register: [], renew: [3, 5, 7, 9] },
      unsold: { register: [], renew: [] },
    })
  })

  it('never offers a period the supplier charges more for than the rule gives (.me, 29 Sept 2026)', () => {
    const me = raw({
      name: 'me',
      prices: prices({
        register: [
          { period: 1, price: 2.29 },
          { period: 2, price: 28.53 },
          { period: 3, price: 51.52 },
        ],
        renew: [
          { period: 1, price: 22.99 },
          { period: 2, price: 45.98 },
        ],
      }),
    })
    expect(sellingTerms(me)).toMatchObject({
      ok: true,
      registerUsd: 2.29,
      registerPeriods: [1],
      renewPeriods: [1, 2],
      dropped: { register: [2, 3], renew: [] },
    })
  })

  it('never offers a period priced off the rule by a cent, either way (.tr)', () => {
    const tr = raw({
      name: 'tr',
      prices: prices({
        register: [
          { period: 1, price: 3.24 },
          { period: 2, price: 6.71 },
        ],
        renew: [
          { period: 1, price: 3.46 },
          { period: 2, price: 6.91 },
        ],
      }),
    })
    expect(sellingTerms(tr)).toMatchObject({
      registerPeriods: [1],
      renewPeriods: [1],
      dropped: { register: [2], renew: [2] },
    })
  })

  it('rounds a per-year rate up, so a block is never costed below its listed price', () => {
    const thirds = raw({
      name: 'x',
      registrationPeriods: [3, 6],
      renewalPeriods: [3],
      minRegistrationPeriod: 3,
      prices: prices({
        register: [
          { period: 3, price: 100 },
          { period: 6, price: 200 },
        ],
        renew: [{ period: 3, price: 100 }],
      }),
    })
    const terms = sellingTerms(thirds)
    expect(terms).toMatchObject({
      ok: true,
      registerUsd: 33.3334,
      renewUsd: 33.3334,
      registerPeriods: [3, 6],
      renewPeriods: [3],
    })
  })

  it('sells .as for its two-year first term, renewing a year at a time', () => {
    const as = raw({
      name: 'as',
      minRegistrationPeriod: 2,
      maxRegistrationPeriod: 2,
      registrationPeriods: [2],
      renewalPeriods: [1, 3, 2, 4, 5, 6, 7, 8, 9, 10],
      prices: prices({
        register: [{ period: 2, price: 269.99 }],
        renew: YEARS.map((period) => ({ period, price: 135 * period })),
      }),
    })
    expect(toRow(as)).toMatchObject({
      register_usd: 134.995,
      renew_usd: 135,
      min_period: 2,
      max_period: 2,
      register_periods: [2],
      renew_periods: YEARS,
    })
  })

  it('keeps registration inside the listing’s own minimum and maximum', () => {
    expect(sellingTerms(raw({ minRegistrationPeriod: 1, maxRegistrationPeriod: 5 }))).toMatchObject(
      { registerPeriods: [1, 2, 3, 4, 5], renewPeriods: YEARS },
    )
  })

  it('refuses an extension with no register or no renewal price it can use', () => {
    expect(sellingTerms(raw({ prices: prices({ register: [] }) }))).toEqual({
      ok: false,
      reason: 'no register price',
    })
    expect(sellingTerms(raw({ registrationPeriods: [11] }))).toEqual({
      ok: false,
      reason: 'no register price',
    })
    expect(sellingTerms(raw({ prices: prices({ renew: [{ period: 1, price: 0 }] }) }))).toEqual({
      ok: false,
      reason: 'no renewal price',
    })
  })
})

describe('termsNotes', () => {
  it('lists blocks, dropped periods and extensions that cannot be sold, for the report', () => {
    const notes = termsNotes([
      raw(),
      { ...AI, renewalPeriods: YEARS },
      raw({ name: 'tn', prices: prices({ renew: [] }) }),
      { name: 'dad', prices: [] },
      { name: 'ai', prices: [] },
      { name: ' ' },
    ])
    expect(notes.multiYear.map((entry) => entry.name)).toEqual(['ai'])
    expect(notes.dropped).toEqual([{ name: 'ai', register: [], renew: [3, 5, 7, 9] }])
    expect(notes.unsold).toEqual([])
    expect(notes.unsellable).toEqual([{ name: 'tn', reason: 'no renewal price' }])
    expect(notes.unpriced).toBe(1)
    expect(termsNotes([AI]).unsold).toEqual([{ name: 'ai', register: [], renew: [3, 5, 7, 9] }])
  })
})

describe('yearsList', () => {
  it('joins runs of three or more, and keeps the rest as they are', () => {
    expect(yearsList(YEARS)).toBe('1–10')
    expect(yearsList([2, 4, 6, 8, 10])).toBe('2 4 6 8 10')
    expect(yearsList([1, 2, 3, 5, 7, 8])).toBe('1–3 5 7 8')
    expect(yearsList([])).toBe('')
  })
})

describe('toRows', () => {
  it('keeps the first listing of a name, drops what it cannot price, and sorts', () => {
    const rows = toRows([
      raw({ name: 'net' }),
      raw({ name: 'com' }),
      raw({ name: 'com', prices: prices({ register: [{ period: 1, price: 99 }] }) }),
      raw({ name: 'free', prices: prices({ register: [] }) }),
    ])
    expect(rows.map((r) => [r.name, r.register_usd])).toEqual([
      ['com', 11.31],
      ['net', 11.31],
    ])
  })
})

describe('compareCatalogue', () => {
  it('finds nothing to do when the table already matches', () => {
    const diff = compareCatalogue([row()], [current()])
    expect(diff).toEqual({
      added: [],
      retired: [],
      priceChanges: [],
      detailChanges: [],
      unchanged: 1,
    })
    expect(hasChanges(diff)).toBe(false)
  })

  it('reads the table’s numeric columns whether they arrive as numbers or strings', () => {
    const diff = compareCatalogue(
      [row()],
      [current({ register_usd: '11.3100' as never, transfer_usd: '11.51' as never })],
    )
    expect(diff.unchanged).toBe(1)
  })

  it('reports added extensions, price changes and other changes separately', () => {
    const diff = compareCatalogue(
      [
        row(),
        row({ name: 'net', register_usd: 14 }),
        row({ name: 'org', is_transferable: null }),
        row({ name: 'io', restore_usd: null, min_chars: 3 }),
      ],
      [
        current(),
        current({ name: 'net', register_usd: 13 }),
        current({ name: 'org' }),
        current({ name: 'io', restore_usd: 90 }),
      ],
    )
    expect(diff.added).toEqual([])
    expect(diff.priceChanges.map((change) => change.row.name)).toEqual(['net', 'io'])
    expect(diff.detailChanges).toEqual(['org', 'io'])
    expect(diff.unchanged).toBe(1)
    expect(hasChanges(diff)).toBe(true)
  })

  it('retires only extensions still on sale, and sells again one that comes back', () => {
    const diff = compareCatalogue(
      [row({ name: 'net' })],
      [
        current({ name: 'com' }),
        current({ name: 'old', is_sellable: false }),
        current({ name: 'net', is_sellable: false }),
      ],
    )
    expect(diff.retired).toEqual(['com'])
    expect(diff.detailChanges).toEqual(['net'])
  })

  it.each([
    ['min_period', 2],
    ['max_period', 5],
    ['redemption_days', 40],
    ['requires_extra_fields', true],
    ['max_chars', 63],
    ['renew_usd', 12],
    ['transfer_usd', null],
  ] as const)('notices a change in %s', (column, value) => {
    const changed = row({ [column]: value } as Partial<TldRow>)
    expect(hasChanges(compareCatalogue([changed], [current()]))).toBe(true)
  })

  it('reads a row stored before migration 37 as selling every year from min to max', () => {
    const before37 = current({ register_periods: null, renew_periods: null })
    expect(periodsOf(before37)).toEqual({ register: YEARS, renew: YEARS })
    expect(compareCatalogue([row()], [before37]).unchanged).toBe(1)
  })

  it('notices periods that stop being offered, whatever the other columns say', () => {
    const narrowed = row({ register_periods: [1], renew_periods: [1, 2] })
    const diff = compareCatalogue([narrowed], [current({ register_periods: null })])
    expect(diff.detailChanges).toEqual(['com'])
    expect(diff.priceChanges).toEqual([])
  })

  it('adds an extension the table does not have', () => {
    const diff = compareCatalogue([row({ name: 'xyz' })], [])
    expect(diff.added.map((r) => r.name)).toEqual(['xyz'])
    expect(hasChanges(diff)).toBe(true)
  })
})

describe('refusing a listing it cannot trust', () => {
  const items = [raw()]

  it('refuses a listing that does not say how long it is', () => {
    expect(listingRefusal({ items, total: null }, toRows(items))).toMatch(/did not say how many/)
  })

  it('refuses a short read, which would retire everything it missed', () => {
    expect(listingRefusal({ items, total: 723 }, toRows(items))).toBe(
      'The supplier said 723 extensions and listed 1',
    )
  })

  it('refuses a listing with nothing it can price', () => {
    const unpriced = [raw({ prices: [] })]
    expect(listingRefusal({ items: unpriced, total: 1 }, toRows(unpriced))).toMatch(/no extension/)
  })

  it('accepts a complete listing', () => {
    expect(listingRefusal({ items, total: 1 }, toRows(items))).toBeNull()
  })

  it('refuses to stop selling more than a tenth of the catalogue at once', () => {
    const table = Array.from({ length: 700 }, (_, i) => current({ name: `t${i}` }))
    const listed = table.slice(71).map((tld) => row({ name: tld.name }))
    expect(retirementRefusal(compareCatalogue(listed, table), table)).toBe(
      'Would stop selling 71 of 700 extensions at once (limit 70)',
    )
    const fewer = table.slice(70).map((tld) => row({ name: tld.name }))
    expect(retirementRefusal(compareCatalogue(fewer, table), table)).toBeNull()
  })

  it('lets a small catalogue lose a few extensions', () => {
    const table = Array.from({ length: 30 }, (_, i) => current({ name: `t${i}` }))
    const listed = table.slice(25).map((tld) => row({ name: tld.name }))
    expect(retirementRefusal(compareCatalogue(listed, table), table)).toBeNull()
    expect(retirementRefusal(compareCatalogue(listed.slice(1), table), table)).toMatch(/26 of 30/)
  })
})

describe('formatReport', () => {
  it('says what changes, before anything is written', () => {
    const diff = compareCatalogue(
      [
        row({ register_usd: 12 }),
        row({ name: 'xyz' }),
        row({ name: 'org', is_transferable: null }),
      ],
      [current(), current({ name: 'gone' }), current({ name: 'org' })],
    )
    const text = formatReport(diff, 3, 3).join('\n')
    expect(text).toContain('Fetched 3 extensions from the reseller platform; 3 sellable')
    expect(text).toContain(
      '+1 added · -1 retired · ~1 price changes · ~1 other changes · 0 unchanged',
    )
    expect(text).toContain('Added:   .xyz')
    expect(text).toContain('Retired: .gone')
    expect(text).toContain('register $11.31 → $12.00   renew $11.51 → $11.51')
    expect(text).toContain('Other changes (periods, limits, transfers, eligibility): .org')
  })

  it('shows a dash for a price that was not there', () => {
    const diff = compareCatalogue([row({ restore_usd: 5 })], [current({ restore_usd: null })])
    expect(formatReport(diff, 1, 1).join('\n')).toContain('register $11.31 → $11.31')
    const transfer = compareCatalogue(
      [row({ register_usd: 5 })],
      [current({ register_usd: null as never })],
    )
    expect(formatReport(transfer, 1, 1).join('\n')).toContain('register — → $5.00')
  })

  it('says which extensions sell in blocks, which periods are left out, and what cannot be sold', () => {
    const items = [
      raw(),
      AI,
      raw({ name: 'me', prices: prices({ register: [...prices()[0]!.register].slice(0, 9) }) }),
      raw({ name: 'tn', prices: prices({ renew: [] }) }),
      { name: 'dad', prices: [] },
    ]
    const rows = toRows(items)
    const text = formatReport(
      compareCatalogue(rows, [current()]),
      items.length,
      rows.length,
      termsNotes(items),
    ).join('\n')
    expect(text).toContain(
      'Sold in multi-year terms (years a registration · a renewal can be bought for):\n' +
        '  .ai              register 2 4 6 8 10 · renew 2 4 6 8 10   ($99.90/yr, renews $99.90/yr)',
    )
    expect(text).toContain(
      'Periods not offered — priced, but not ones the registry sells:\n' +
        '  .ai              renew 3 5 7 9',
    )
    expect(text).toContain('Not sold — listed with prices we cannot state: .tn (no renewal price)')
    expect(text).toContain('1 listed with no price at all.')
  })

  it('lists the periods priced off the per-year rate', () => {
    const me = raw({
      name: 'me',
      prices: prices({
        register: [
          { period: 1, price: 2.29 },
          { period: 2, price: 28.53 },
        ],
      }),
    })
    const text = formatReport(compareCatalogue(toRows([me]), []), 1, 1, termsNotes([me])).join('\n')
    expect(text).toContain(
      'Periods not offered — priced off the per-year rate, so we would charge other than they cost:\n' +
        '  .me              register 2',
    )
  })

  it('keeps a long report readable', () => {
    const names = Array.from({ length: 32 }, (_, i) => `t${i}`)
    const diff = compareCatalogue(
      names.map((name) => row({ name, register_usd: 20, is_transferable: false })),
      names.map((name) => current({ name })),
    )
    const text = formatReport(diff, 32, 32).join('\n')
    expect(text).toContain('… and 2 more')
    expect(text).toMatch(/\.t29 … and 2 more$/m)
  })
})
