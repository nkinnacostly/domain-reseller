import { describe, expect, it } from 'vitest'
import { toUnicodeHost } from '../lib/idn'
import { GRID_SIZE, planSearch, stemIssue, suggestionNames, suggestionNamesFor } from '../lib/plan'

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

describe('suggestionNames — international names (FR-S8)', () => {
  it('puts the affixes on the name as people read it, then writes it in ASCII', () => {
    const names = suggestionNames('xn--caf-dma')
    expect(names[0]).toBe('xn--getcaf-gva')
    expect(names.map(toUnicodeHost)).toContain('caféhq')
  })

  it('offers no Latin affix on a Cyrillic name — together they would be a lookalike', () => {
    // аррӏе, all Cyrillic.
    expect(suggestionNames('xn--80ak6aa92e')).toEqual([])
  })
})

describe('planSearch — length rules (FR-S9)', () => {
  const rules = { io: { min: 3, max: 63 }, com: { min: null, max: 10 }, edu: { min: 5, max: 5 } }

  it('keeps only the rules for the extensions it will ask about', () => {
    const plan = planSearch({
      stem: 'ab',
      tld: 'io',
      sold: SOLD,
      featured: FEATURED,
      lengthRules: rules,
    })
    expect(plan.lengthRules).toEqual({ io: rules.io, com: rules.com })
  })

  it('knows which extensions refuse the name outright', () => {
    const plan = planSearch({
      stem: 'ab',
      tld: 'io',
      sold: SOLD,
      featured: FEATURED,
      lengthRules: rules,
    })
    expect(stemIssue(plan, 'io')).toEqual({ kind: 'too-short', min: 3, max: 63 })
    expect(stemIssue(plan, 'com')).toBeNull()
    expect(stemIssue(plan, 'net')).toBeNull()
  })

  it('never offers a suggestion an extension would refuse', () => {
    const plan = planSearch({
      stem: 'mybrand',
      tld: null,
      sold: SOLD,
      featured: FEATURED,
      lengthRules: rules,
    })
    const onCom = suggestionNamesFor(plan, 'com')
    expect(onCom).toContain('getmybrand') // exactly 10, the limit
    expect(onCom).not.toContain('mybrandonline') // 13
    expect(suggestionNamesFor(plan, 'net')).toContain('mybrandonline')
  })

  it('has no rules when the catalogue knows none', () => {
    const plan = planSearch({ stem: 'ab', tld: null, sold: SOLD, featured: FEATURED })
    expect(plan.lengthRules).toEqual({})
    expect(stemIssue(plan, 'com')).toBeNull()
  })
})
