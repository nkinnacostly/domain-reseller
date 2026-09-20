import { describe, expect, it } from 'vitest'
import { diffCatalogue, hasChanges, retailImpact } from './diff'
import { type CatalogueEntry, PLACEHOLDER_FX } from './policy'

const entry = (over: Partial<CatalogueEntry> & { name: string }): CatalogueEntry => ({
  register: 10,
  renew: 10,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  ...over,
})

describe('diffCatalogue', () => {
  it('reports nothing for an identical catalogue', () => {
    const cat = [entry({ name: 'ng' }), entry({ name: 'com' })]
    const diff = diffCatalogue(cat, cat)

    expect(hasChanges(diff)).toBe(false)
    expect(diff.unchanged).toBe(2)
  })

  it('detects an added TLD', () => {
    const diff = diffCatalogue(
      [entry({ name: 'ng' })],
      [entry({ name: 'ng' }), entry({ name: 'new' })],
    )
    expect(diff.added.map((e) => e.name)).toEqual(['new'])
  })

  it('detects a removed TLD, which would orphan anything already sold', () => {
    const diff = diffCatalogue(
      [entry({ name: 'ng' }), entry({ name: 'gone' })],
      [entry({ name: 'ng' })],
    )
    expect(diff.removed.map((e) => e.name)).toEqual(['gone'])
  })

  /** The Verisign case: .com wholesale rises on 1 November 2026. */
  it('detects a registration price rise and reports both values', () => {
    const diff = diffCatalogue(
      [entry({ name: 'com', register: 11.31 })],
      [entry({ name: 'com', register: 12.02 })],
    )

    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]?.changes).toEqual([{ field: 'register', before: 11.31, after: 12.02 }])
  })

  it('detects a renewal change independently of registration', () => {
    const diff = diffCatalogue(
      [entry({ name: 'com', register: 11, renew: 11 })],
      [entry({ name: 'com', register: 11, renew: 14 })],
    )
    expect(diff.changed[0]?.changes.map((c) => c.field)).toEqual(['renew'])
  })

  it('detects a transfer price appearing where there was none', () => {
    const diff = diffCatalogue([entry({ name: 'ng' })], [entry({ name: 'ng', transfer: 11.99 })])
    expect(diff.changed[0]?.changes).toEqual([
      { field: 'transfer', before: undefined, after: 11.99 },
    ])
  })

  it('ignores fields that are not prices', () => {
    const diff = diffCatalogue(
      [entry({ name: 'ng', maxPeriod: 5 })],
      [entry({ name: 'ng', maxPeriod: 10 })],
    )
    expect(hasChanges(diff)).toBe(false)
  })
})

describe('retailImpact', () => {
  const com = (register: number): CatalogueEntry =>
    entry({ name: 'com', register, renew: register })

  it('stays quiet when nothing changed', () => {
    expect(retailImpact([com(11.31)], [com(11.31)], PLACEHOLDER_FX)).toEqual([])
  })

  /** The Verisign case: +$0.71 on .com, effective 1 November 2026. */
  it('reports the retail move for a cost rise', () => {
    const impacts = retailImpact([com(11.31)], [com(12.02)], PLACEHOLDER_FX)
    const registration = impacts.find((i) => i.kind === 'registration')

    expect(registration?.currentRetailNgn).toBe(20_500)
    expect(registration?.newRetailNgn).toBe(21_500)
    expect(registration?.deltaNgn).toBe(1000)
  })

  it('does not claim a loss when the old price still covers the new cost', () => {
    const impacts = retailImpact([com(11.31)], [com(12.02)], PLACEHOLDER_FX)
    expect(impacts.every((i) => i.sellingBelowCost)).toBe(false)
  })

  /**
   * The case worth paging someone about: the supplier raised the cost past
   * what we are still charging, so every sale until redeploy loses money.
   */
  it('flags selling below cost when a rise overtakes the live price', () => {
    const impacts = retailImpact([com(11.31)], [com(20)], PLACEHOLDER_FX)
    const registration = impacts.find((i) => i.kind === 'registration')

    expect(registration?.sellingBelowCost).toBe(true)
    expect(registration?.currentRetailNgn).toBe(20_500)
  })

  it('puts loss-making TLDs first, then the biggest increases', () => {
    const impacts = retailImpact(
      [com(11.31), entry({ name: 'xyz', register: 1.99, renew: 1.99 })],
      [com(20), entry({ name: 'xyz', register: 2.5, renew: 2.5 })],
      PLACEHOLDER_FX,
    )
    expect(impacts[0]?.sellingBelowCost).toBe(true)
  })

  it('reports a price cut as a negative delta rather than hiding it', () => {
    const impacts = retailImpact([com(20)], [com(11.31)], PLACEHOLDER_FX)
    expect(impacts.find((i) => i.kind === 'registration')?.deltaNgn).toBeLessThan(0)
  })
})
