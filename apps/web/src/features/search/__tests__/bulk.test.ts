import { AVAILABILITY_LIMITS } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import {
  BULK_MAX_EXTENSIONS,
  BULK_MAX_NAMES,
  type BulkLine,
  bulkHref,
  chunkChecks,
  chunkFor,
  pickDefaultTlds,
  planBulk,
  splitNames,
} from '../lib/bulk'

const SOLD = new Set(['com', 'net', 'org', 'africa', 'io', 'co', 'app', 'dev', 'com.ng'])
const FEATURED = ['com', 'net', 'org', 'africa', 'co', 'app']

const plan = (text: string, picked: string[] = [], lengthRules = {}) =>
  planBulk({ text, picked, sold: SOLD, featured: FEATURED, lengthRules })

const checksOf = (line: BulkLine | undefined) => (line?.kind === 'name' ? line.checks : [])

describe('bulk search limits', () => {
  it('fits every extension of a bulk search in one gateway request per extension (PRD V4)', () => {
    expect(BULK_MAX_NAMES).toBeLessThanOrEqual(AVAILABILITY_LIMITS.maxNames)
    expect(BULK_MAX_EXTENSIONS).toBeLessThanOrEqual(AVAILABILITY_LIMITS.maxTlds)
  })
})

describe('splitNames', () => {
  it('reads one name per line, and the commas and spaces lists arrive with', () => {
    expect(splitNames('getpaid\r\nmybrand.com, other.net;  last\n\n')).toEqual([
      'getpaid',
      'mybrand.com',
      'other.net',
      'last',
    ])
  })

  it('finds nothing in blank input', () => {
    expect(splitNames(' \n\t ')).toEqual([])
  })
})

describe('pickDefaultTlds', () => {
  it('uses the lead extension when none is picked', () => {
    expect(pickDefaultTlds([], SOLD, FEATURED)).toEqual(['com'])
  })

  it('keeps picked extensions we sell, once each, and drops the rest', () => {
    expect(pickDefaultTlds(['NET', 'edu', 'net', 'africa'], SOLD, FEATURED)).toEqual([
      'net',
      'africa',
    ])
  })

  it('checks on no more than the featured set allows', () => {
    const many = [...SOLD]
    expect(pickDefaultTlds(many, SOLD, FEATURED)).toHaveLength(BULK_MAX_EXTENSIONS)
  })

  it('has nothing to check on when nothing we sell is featured', () => {
    expect(pickDefaultTlds([], SOLD, ['edu'])).toEqual([])
  })
})

describe('planBulk — each line gets its own answer (FR-S5)', () => {
  it('checks a name with an extension on that extension only', () => {
    const { lines } = plan('mybrand.africa')
    expect(lines).toEqual([
      {
        kind: 'name',
        input: 'mybrand.africa',
        display: 'mybrand.africa',
        checks: [{ name: 'mybrand', tld: 'africa', domain: 'mybrand.africa', issue: null }],
      },
    ])
  })

  it('checks a bare name on every extension picked for bare names', () => {
    const { lines, defaultTlds } = plan('getpaid', ['com', 'net'])
    expect(defaultTlds).toEqual(['com', 'net'])
    expect(checksOf(lines[0]).map((check) => check.domain)).toEqual(['getpaid.com', 'getpaid.net'])
  })

  it('explains, without asking anyone, a line that is not a domain', () => {
    const { lines, chunks } = plan('not_a_name')
    expect(lines).toEqual([{ kind: 'invalid', input: 'not_a_name' }])
    expect(chunks).toEqual([])
  })

  it('refuses a lookalike mixing alphabets (FR-S8)', () => {
    // Cyrillic а in a Latin name.
    expect(plan('pаypal.com').lines).toEqual([
      { kind: 'mixed-script', input: 'pаypal.com', scripts: ['Latin', 'Cyrillic'] },
    ])
  })

  it('names an extension we do not sell', () => {
    expect(plan('school.edu').lines).toEqual([
      { kind: 'unsold', input: 'school.edu', display: 'school.edu', tld: 'edu' },
    ])
  })

  it('checks an international name in its ASCII form and shows the readable one', () => {
    const [line] = plan('Café.com').lines
    expect(line).toMatchObject({ kind: 'name', display: 'café.com' })
    expect(checksOf(line)[0]?.domain).toBe('xn--caf-dma.com')
  })

  it('answers a name its extension is too short for without a supplier call (FR-S9)', () => {
    const { lines, chunks } = plan('ab.io\ngetpaid.io', [], { io: { min: 3, max: 63 } })
    expect(checksOf(lines[0])[0]?.issue).toEqual({ kind: 'too-short', min: 3, max: 63 })
    expect(chunks).toEqual([{ names: ['getpaid'], tlds: ['io'] }])
  })

  it('treats the same name typed twice, in any case, as one line', () => {
    expect(plan('GetPaid.com\ngetpaid.com\nhttps://getpaid.com/').lines).toHaveLength(1)
  })

  it(`checks the first ${BULK_MAX_NAMES} names and counts the rest`, () => {
    const names = Array.from({ length: BULK_MAX_NAMES + 3 }, (_, index) => `name${index}`)
    const result = plan([...names, 'name22'].join('\n'))
    expect(result.lines).toHaveLength(BULK_MAX_NAMES)
    expect(result.skipped).toBe(3)
  })

  it('asks the gateway once for every name on one extension', () => {
    const names = Array.from({ length: BULK_MAX_NAMES }, (_, index) => `name${index}.com`)
    const { chunks } = plan(names.join('\n'))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.tlds).toEqual(['com'])
    expect(chunks[0]?.names).toHaveLength(BULK_MAX_NAMES)
  })
})

describe('chunkChecks — as few gateway requests as the contract allows', () => {
  it('asks about each extension once, with only the names wanted on it', () => {
    expect(
      chunkChecks([
        { name: 'a', tld: 'com' },
        { name: 'b', tld: 'com' },
        { name: 'c', tld: 'io' },
      ]),
    ).toEqual([{ names: ['a', 'b', 'c'], tlds: ['com', 'io'] }])
  })

  it('puts the extension most lines need first', () => {
    const chunks = chunkChecks([
      { name: 'a', tld: 'io' },
      { name: 'b', tld: 'com' },
      { name: 'c', tld: 'com' },
    ])
    expect(chunks[0]?.tlds).toEqual(['com', 'io'])
  })

  it('starts a new request once a request holds as many extensions as allowed', () => {
    const checks = ['a', 'b', 'c'].map((tld) => ({ name: 'x', tld }))
    expect(chunkChecks(checks, { maxNames: 25, maxTlds: 2 })).toEqual([
      { names: ['x'], tlds: ['a', 'b'] },
      { names: ['x'], tlds: ['c'] },
    ])
  })

  it('starts a new request rather than go over the name limit', () => {
    const checks = [
      { name: 'a', tld: 'com' },
      { name: 'b', tld: 'com' },
      { name: 'c', tld: 'io' },
    ]
    expect(chunkChecks(checks, { maxNames: 2, maxTlds: 12 })).toEqual([
      { names: ['a', 'b'], tlds: ['com'] },
      { names: ['c'], tlds: ['io'] },
    ])
  })

  it('asks nothing when there is nothing to ask', () => {
    expect(chunkChecks([])).toEqual([])
  })

  it('finds the one request that answers a check', () => {
    const chunks = [
      { names: ['a'], tlds: ['com'] },
      { names: ['a'], tlds: ['io'] },
    ]
    expect(chunkFor(chunks, { name: 'a', tld: 'io' })).toBe(chunks[1])
    expect(chunkFor(chunks, { name: 'b', tld: 'io' })).toBeUndefined()
  })
})

describe('bulkHref', () => {
  it('puts the names one per line, in their readable form, and repeats each extension', () => {
    const href = bulkHref(['GetPaid.com', 'xn--caf-dma.com', 'not_a_name'], ['com', 'net'])
    const url = new URL(href, 'https://example.test')
    expect(url.pathname).toBe('/search/bulk')
    expect(url.searchParams.get('names')).toBe('getpaid.com\ncafé.com\nnot_a_name')
    expect(url.searchParams.getAll('tld')).toEqual(['com', 'net'])
  })
})
