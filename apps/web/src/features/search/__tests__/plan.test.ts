import { describe, expect, it } from 'vitest'
import { GRID_SIZE, planSearch, suggestionNames } from '../lib/plan'

const SOLD = new Set(['com', 'net', 'org', 'africa', 'co', 'app', 'io', 'dev', 'xyz'])
const FEATURED = ['com', 'net', 'org', 'africa', 'co', 'app']

describe('planSearch', () => {
  it('leads with the top-ranked extension when none was typed', () => {
    const plan = planSearch({ stem: 'getpaid', tld: null, sold: SOLD, featured: FEATURED })
    expect(plan.exact).toEqual({ name: 'getpaid', tld: 'com' })
    expect(plan.unsoldTld).toBeNull()
    expect(plan.gridTlds).toEqual(FEATURED)
  })

  it('leads with the extension the person typed, and checks it first', () => {
    const plan = planSearch({ stem: 'getpaid', tld: 'io', sold: SOLD, featured: FEATURED })
    expect(plan.exact).toEqual({ name: 'getpaid', tld: 'io' })
    expect(plan.gridTlds[0]).toBe('io')
    expect(plan.gridTlds).toHaveLength(GRID_SIZE)
    expect(plan.suggestionTlds).toEqual(['io', 'com'])
  })

  it('says so when the typed extension is not one we sell, and still checks the rest', () => {
    const plan = planSearch({ stem: 'getpaid', tld: 'edu', sold: SOLD, featured: FEATURED })
    expect(plan.exact).toBeNull()
    expect(plan.unsoldTld).toBe('edu')
    expect(plan.gridTlds).toEqual(FEATURED)
  })

  it('never asks about an extension we do not sell, even a featured one', () => {
    const sold = new Set(['com', 'net'])
    const plan = planSearch({ stem: 'getpaid', tld: null, sold, featured: FEATURED })
    expect(plan.gridTlds).toEqual(['com', 'net'])
    expect(plan.suggestionTlds).toEqual(['com', 'net'])
  })

  it('has nothing to lead with when nothing is featured or typed', () => {
    const plan = planSearch({ stem: 'getpaid', tld: null, sold: SOLD, featured: [] })
    expect(plan.exact).toBeNull()
    expect(plan.suggestionTlds).toEqual([])
  })
})

describe('suggestionNames', () => {
  it('applies every ADR-002 affix, prefixes first', () => {
    expect(suggestionNames('paid').slice(0, 3)).toEqual(['getpaid', 'trypaid', 'usepaid'])
    expect(suggestionNames('paid')).toContain('paidhq')
    expect(suggestionNames('paid')).toHaveLength(12)
  })

  it('skips a doubled affix that reads as a typo', () => {
    expect(suggestionNames('getpaid')).not.toContain('getgetpaid')
    expect(suggestionNames('bighub')).not.toContain('bighubhub')
  })

  it('drops anything longer than a DNS label allows', () => {
    const stem = 'a'.repeat(61)
    const names = suggestionNames(stem)
    expect(names).toContain(`go${stem}`) // 63 — the limit
    expect(names).not.toContain(`get${stem}`) // 64 — one over
    expect(names.every((name) => name.length <= 63)).toBe(true)
  })
})
