import { describe, expect, it } from 'vitest'
import {
  type CurrentTld,
  charLimits,
  compareCatalogue,
  formatReport,
  hasChanges,
  listingRefusal,
  priceOf,
  type RawTld,
  requiresExtraFields,
  retirementRefusal,
  type TldRow,
  toRow,
  toRows,
  transferability,
} from './catalogue'

/**
 * The catalogue decides every wholesale cost on the storefront (N5b). What
 * matters: a price is read only when it is certainly a one-year dollar price,
 * nothing is invented where the supplier says nothing, and a listing that
 * looks broken is refused rather than written.
 */

const prices = (over: Record<string, unknown[]> = {}) => [
  {
    priceGroup: 'Reseller',
    register: [
      { period: 2, price: 22.82, currency: 'USD' },
      { period: 1, price: 11.31, currency: 'USD' },
    ],
    renew: [{ period: 1, price: 11.51, currency: 'USD' }],
    transfer: [{ period: 1, price: 11.51, currency: 'USD' }],
    restore: [{ period: 1, price: 80, currency: 'USD' }],
    ...over,
  },
]

/** An extension as the production listing gave it on 24 Sept 2026. */
const raw = (over: Partial<RawTld> = {}): RawTld => ({
  name: 'com',
  minRegistrationPeriod: 1,
  maxRegistrationPeriod: 10,
  deletionRestorablePeriod: 30,
  prices: prices(),
  attributes: [],
  ...over,
})

const row = (over: Partial<TldRow> = {}): TldRow => ({
  name: 'com',
  register_usd: 11.31,
  renew_usd: 11.51,
  transfer_usd: 11.51,
  restore_usd: 80,
  min_period: 1,
  max_period: 10,
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

  it('renews at the register price when no renewal is listed', () => {
    expect(toRow(raw({ prices: prices({ renew: [] }) }))?.renew_usd).toBe(11.31)
  })

  it('falls back to the usual periods when the listing’s are unusable', () => {
    expect(
      toRow(
        raw({
          minRegistrationPeriod: 0,
          maxRegistrationPeriod: 'ten',
          deletionRestorablePeriod: -5,
        }),
      ),
    ).toMatchObject({ min_period: 1, max_period: 10, redemption_days: 0 })
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
