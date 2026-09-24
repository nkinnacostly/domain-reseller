import { AVAILABILITY_LIMITS } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import {
  BULK_CHUNK,
  BULK_MAX_EXTENSIONS,
  BULK_MAX_NAMES,
  type BulkLine,
  checksIn,
  chunkChecks,
  countNames,
  packChecks,
  pickDefaultTlds,
  planBulk,
  splitNames,
} from '../lib/bulk'

const SOLD = new Set(['com', 'net', 'org', 'africa', 'io', 'co', 'app', 'dev', 'com.ng'])
const FEATURED = ['com', 'net', 'org', 'africa', 'co', 'app']

const plan = (text: string, picked: string[] = [], lengthRules = {}) =>
  planBulk({ text, picked, sold: SOLD, featured: FEATURED, lengthRules })

const checksOf = (line: BulkLine | undefined) => (line?.kind === 'name' ? line.checks : [])
const many = (count: number, suffix = '') =>
  Array.from({ length: count }, (_, index) => `name${index}${suffix}`)

describe('bulk search limits (FR-S5, PRD V4)', () => {
  it('takes up to 500 names', () => {
    expect(BULK_MAX_NAMES).toBe(500)
  })

  it('packs a block of names into one request the gateway accepts', () => {
    expect(BULK_CHUNK.maxNames).toBe(AVAILABILITY_LIMITS.maxNames)
    expect(BULK_CHUNK.maxTlds).toBeLessThanOrEqual(AVAILABILITY_LIMITS.maxTlds)
    expect(BULK_MAX_EXTENSIONS).toBe(BULK_CHUNK.maxTlds)
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

describe('countNames', () => {
  it('counts a name typed twice, in any case, once', () => {
    expect(countNames('GetPaid\ngetpaid\nother.com')).toBe(2)
    expect(countNames('')).toBe(0)
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
    expect(pickDefaultTlds([...SOLD], SOLD, FEATURED)).toHaveLength(BULK_MAX_EXTENSIONS)
  })

  it('has nothing to check on when nothing we sell is featured', () => {
    expect(pickDefaultTlds([], SOLD, ['edu'])).toEqual([])
  })
})

describe('planBulk — each line gets its own answer (FR-S5)', () => {
  it('explains, without asking anyone, a line that is not a domain', () => {
    const { lines, chunks, asked } = plan('not_a_name')
    expect(lines).toEqual([{ kind: 'invalid', input: 'not_a_name' }])
    expect(asked).toEqual([])
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

  it('answers a name its extension is too short for without a supplier call (FR-S9)', () => {
    const { lines, chunks } = plan('ab.io\ngetpaid.io', [], { io: { min: 3, max: 63 } })
    expect(checksOf(lines[0])[0]?.issue).toEqual({ kind: 'too-short', min: 3, max: 63 })
    expect(chunks).toEqual([{ names: ['getpaid'], tlds: ['io'] }])
  })

  it('checks a name with an extension on that extension only', () => {
    expect(plan('mybrand.africa').lines).toEqual([
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

  it('checks an international name in its ASCII form and shows the readable one', () => {
    const [line] = plan('Café.com').lines
    expect(line).toMatchObject({ kind: 'name', display: 'café.com' })
    expect(checksOf(line)[0]?.domain).toBe('xn--caf-dma.com')
  })

  it('treats the same name typed twice, in any case, as one line', () => {
    expect(plan('GetPaid.com\ngetpaid.com\nhttps://getpaid.com/').lines).toHaveLength(1)
  })

  it('asks once about a name typed bare and with an extension it would get anyway', () => {
    const { lines, asked } = plan('getpaid\ngetpaid.com', ['com', 'net'])
    expect(lines).toHaveLength(2)
    expect(asked.map((check) => check.domain)).toEqual(['getpaid.com', 'getpaid.net'])
  })

  it(`checks the first ${BULK_MAX_NAMES} names and counts the rest`, () => {
    const result = plan([...many(BULK_MAX_NAMES + 3), 'name22'].join('\n'))
    expect(result.lines).toHaveLength(BULK_MAX_NAMES)
    expect(result.skipped).toBe(3)
  })

  it('checks 500 names on three extensions in ten requests, not 1,500 (FR-S5)', () => {
    const { chunks, asked } = plan(many(500).join('\n'), ['com', 'net', 'africa'])
    expect(asked).toHaveLength(1_500)
    expect(chunks).toHaveLength(10)
    for (const chunk of chunks) {
      expect(chunk.names).toHaveLength(50)
      expect(chunk.tlds).toEqual(['com', 'net', 'africa'])
    }
    // Every question is asked exactly once.
    expect(chunks.flatMap((chunk) => checksIn(chunk, asked))).toHaveLength(1_500)
  })

  it('keeps the list order, so rows fill from the top', () => {
    const { chunks } = plan(many(120).join('\n'))
    expect(chunks.map((chunk) => chunk.names[0])).toEqual(['name0', 'name50', 'name100'])
  })

  it('keeps the rules it was planned with, for a retry', () => {
    const rules = { io: { min: 3, max: 63 } }
    expect(plan('getpaid.io', [], rules).lengthRules).toBe(rules)
  })
})

describe('chunkChecks — as few gateway requests as the work allows', () => {
  it('asks nothing when there is nothing to ask', () => {
    expect(chunkChecks([])).toEqual([])
  })

  it('blocks names wanted on the same extensions together', () => {
    const checks = ['a', 'b'].flatMap((name) => ['com', 'net'].map((tld) => ({ name, tld })))
    expect(chunkChecks(checks)).toEqual([{ names: ['a', 'b'], tlds: ['com', 'net'] }])
  })

  it('shares a request between small blocks on different extensions', () => {
    expect(
      chunkChecks([
        { name: 'a', tld: 'com' },
        { name: 'b', tld: 'com' },
        { name: 'c', tld: 'io' },
      ]),
    ).toEqual([{ names: ['a', 'b', 'c'], tlds: ['com', 'io'] }])
  })

  it('starts a new request rather than go over the name limit', () => {
    const checks = [
      { name: 'a', tld: 'com' },
      { name: 'b', tld: 'com' },
      { name: 'c', tld: 'io' },
    ]
    expect(chunkChecks(checks, { limits: { maxNames: 2, maxTlds: 12 } })).toEqual([
      { names: ['a', 'b'], tlds: ['com'] },
      { names: ['c'], tlds: ['io'] },
    ])
  })

  it('splits one name set across requests once it has more extensions than a request takes', () => {
    const checks = ['a', 'b', 'c'].map((tld) => ({ name: 'x', tld }))
    expect(chunkChecks(checks, { limits: { maxNames: 25, maxTlds: 2 } })).toEqual([
      { names: ['x'], tlds: ['a', 'b'] },
      { names: ['x'], tlds: ['c'] },
    ])
  })

  it('splits many names on one extension into blocks of the limit', () => {
    const checks = many(120).map((name) => ({ name, tld: 'com' }))
    expect(chunkChecks(checks).map((chunk) => chunk.names.length)).toEqual([50, 50, 20])
  })

  it('never shares a request that would ask about a name an extension refuses (FR-S9)', () => {
    const checks = [
      { name: 'ab', tld: 'com' },
      { name: 'getpaid', tld: 'io' },
    ]
    const canAsk = (name: string, tld: string) => !(tld === 'io' && name.length < 3)
    expect(chunkChecks(checks, { canAsk })).toEqual([
      { names: ['ab'], tlds: ['com'] },
      { names: ['getpaid'], tlds: ['io'] },
    ])
  })

  it('packs by the length rules it is given', () => {
    const checks = [
      { name: 'ab', tld: 'com', domain: 'ab.com', issue: null },
      { name: 'getpaid', tld: 'io', domain: 'getpaid.io', issue: null },
    ]
    expect(packChecks(checks, { io: { min: 3, max: 63 } })).toHaveLength(2)
    expect(packChecks(checks, {})).toHaveLength(1)
  })
})

describe('checksIn', () => {
  it('finds the checks a request answers, and no others', () => {
    const checks = [
      { name: 'a', tld: 'com' },
      { name: 'a', tld: 'io' },
      { name: 'b', tld: 'io' },
    ]
    expect(checksIn({ names: ['a'], tlds: ['io'] }, checks)).toEqual([{ name: 'a', tld: 'io' }])
  })
})
