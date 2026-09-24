import { describe, expect, it } from 'vitest'
import { planBulk } from '../lib/bulk'
import {
  type BulkAnswer,
  type BulkPrice,
  type BulkRun,
  failureReason,
  filterRows,
  isSelectable,
  progress,
  reduceRun,
  resultRows,
  retryChunks,
  sortRows,
  startRun,
  tally,
  uncheckedDomains,
} from '../lib/bulk-run'

const SOLD = new Set(['com', 'net', 'io', 'app'])
const FEATURED = ['com', 'net']

const price = (registerKobo: number, renewKobo = registerKobo): BulkPrice => ({
  register: `₦${registerKobo / 100}`,
  renew: `₦${renewKobo / 100}`,
  renewalIsHigher: renewKobo > registerKobo,
  includesIcannFee: true,
  maxPeriod: 10,
  registerKobo,
  renewKobo,
})
const PRICES = { com: price(1_820_000, 1_900_000), net: price(2_000_000), io: price(5_000_000) }

const newRun = (text: string, picked: string[] = ['com'], lengthRules = {}) =>
  startRun(1, planBulk({ text, picked, sold: SOLD, featured: FEATURED, lengthRules }))

/** Every asked pair in the chunk answered, `statuses` overriding `available`. */
function answer(
  run: BulkRun,
  index: number,
  statuses: Record<string, 'available' | 'registered' | 'premium' | 'restricted' | 'unknown'> = {},
): BulkRun {
  const chunk = run.plan.chunks[index]
  if (!chunk) throw new Error(`no chunk ${index}`)
  const reply: BulkAnswer = {
    ok: true,
    results: chunk.names.flatMap((name) =>
      chunk.tlds.map((tld) => ({
        domain: `${name}.${tld}`,
        status: statuses[`${name}.${tld}`] ?? 'available',
      })),
    ),
    prices: PRICES,
  }
  return reduceRun(run, { type: 'answer', id: run.id, chunk, answer: reply }) as BulkRun
}

const fail = (run: BulkRun, index: number, reason: 'unavailable' | 'busy' | 'limited') =>
  reduceRun(run, {
    type: 'answer',
    id: run.id,
    chunk: run.plan.chunks[index] as NonNullable<(typeof run.plan.chunks)[number]>,
    answer: { ok: false, reason },
  }) as BulkRun

const finish = (run: BulkRun) => reduceRun(run, { type: 'finish', id: run.id }) as BulkRun
const categories = (run: BulkRun) =>
  Object.fromEntries(resultRows(run).map((row) => [row.display, row.category]))

describe('a bulk run — failures first (FR-S5)', () => {
  it('leaves every name in a failed block not checked, and the rest answered', () => {
    const names = Array.from({ length: 60 }, (_, index) => `n${index}`)
    let run = newRun(names.join('\n'))
    run = fail(run, 0, 'unavailable')
    run = finish(answer(run, 1))

    expect(tally(resultRows(run))).toMatchObject({ unchecked: 50, available: 10, pending: 0 })
    expect(failureReason(run)).toBe('unavailable')
    expect(uncheckedDomains(run)).toHaveLength(50)
    expect(uncheckedDomains(run)[0]).toBe('n0.com')
  })

  it('treats a name the registry did not answer for as not checked, never as free', () => {
    let run = newRun('getpaid\nother')
    run = finish(answer(run, 0, { 'getpaid.com': 'unknown' }))
    expect(categories(run)).toEqual({ 'getpaid.com': 'unchecked', 'other.com': 'available' })
  })

  it('treats a name missing from the answer as not checked', () => {
    let run = newRun('getpaid')
    const chunk = run.plan.chunks[0]
    if (!chunk) throw new Error('no chunk')
    run = reduceRun(run, {
      type: 'answer',
      id: run.id,
      chunk,
      answer: { ok: true, results: [], prices: PRICES },
    }) as BulkRun
    expect(categories(run)).toEqual({ 'getpaid.com': 'unchecked' })
  })

  it('stops the blocks not yet asked with the reason, leaving answered ones alone', () => {
    const names = Array.from({ length: 120 }, (_, index) => `n${index}`)
    let run = answer(newRun(names.join('\n')), 0)
    run = fail(run, 1, 'limited')
    run = reduceRun(run, {
      type: 'halt',
      id: run.id,
      chunks: run.plan.chunks.slice(2),
      reason: 'limited',
    }) as BulkRun

    expect(tally(resultRows(run))).toMatchObject({ available: 50, unchecked: 70 })
    expect(failureReason(run)).toBe('limited')
  })

  it('leads with the reason a person has to act on', () => {
    const names = Array.from({ length: 150 }, (_, index) => `n${index}`)
    let run = newRun(names.join('\n'))
    run = fail(run, 0, 'unavailable')
    run = fail(run, 1, 'busy')
    expect(failureReason(run)).toBe('busy')
    run = fail(run, 2, 'limited')
    expect(failureReason(run)).toBe('limited')
  })

  it('has no failure to report when everything was checked', () => {
    expect(failureReason(finish(answer(newRun('getpaid'), 0)))).toBeNull()
  })

  it('ignores an answer for a run that has been replaced', () => {
    const older = newRun('getpaid')
    const newer = startRun(2, older.plan)
    const chunk = older.plan.chunks[0]
    if (!chunk) throw new Error('no chunk')
    const after = reduceRun(newer, {
      type: 'answer',
      id: 1,
      chunk,
      answer: { ok: true, results: [{ domain: 'getpaid.com', status: 'available' }], prices: {} },
    })
    expect(after).toBe(newer)
    expect(reduceRun(null, { type: 'finish', id: 1 })).toBeNull()
  })

  it('does not overwrite an answer with a late failure', () => {
    let run = answer(newRun('getpaid'), 0)
    run = fail(run, 0, 'unavailable')
    expect(categories(run)).toEqual({ 'getpaid.com': 'available' })
  })
})

describe('a bulk run — retrying only what was not checked', () => {
  it('asks again about the failed names only, packed afresh', () => {
    const names = Array.from({ length: 60 }, (_, index) => `n${index}`)
    let run = finish(answer(fail(newRun(names.join('\n')), 0, 'unavailable'), 1))

    const chunks = retryChunks(run)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.names).toHaveLength(50)
    expect(chunks[0]?.names).not.toContain('n55')

    run = reduceRun(run, { type: 'retry', id: run.id }) as BulkRun
    expect(run.running).toBe(true)
    expect(tally(resultRows(run))).toMatchObject({ pending: 50, available: 10, unchecked: 0 })
  })

  it('has nothing to retry when everything was checked', () => {
    expect(retryChunks(finish(answer(newRun('getpaid'), 0)))).toEqual([])
  })
})

describe('progress — "312 of 500 checked"', () => {
  it('counts names, not rows, and a line refused here as checked at once', () => {
    let run = newRun('getpaid\nother\nnot_a_name', ['com', 'net'])
    expect(progress(run)).toEqual({ total: 3, checked: 1, settled: 1 })

    run = answer(run, 0, {})
    expect(progress(run)).toEqual({ total: 3, checked: 3, settled: 3 })
  })

  it('counts a name that could not be checked as settled, not checked', () => {
    const run = fail(newRun('getpaid'), 0, 'unavailable')
    expect(progress(run)).toEqual({ total: 1, checked: 0, settled: 1 })
  })

  it('does not run when there is nothing to ask', () => {
    expect(newRun('not_a_name').running).toBe(false)
    expect(newRun('getpaid').running).toBe(true)
  })
})

describe('result rows', () => {
  it('gives every line its row, in the order typed, with why a refusal was refused', () => {
    const run = finish(
      answer(
        newRun('not_a_name\nschool.edu\npаypal.com\nab.io\ngetpaid', ['com'], {
          io: { min: 3, max: 63 },
        }),
        0,
      ),
    )
    const rows = resultRows(run)

    expect(rows.map((row) => [row.display, row.category, row.label])).toEqual([
      ['not_a_name', 'refused', 'Not a domain'],
      ['school.edu', 'refused', 'Not sold'],
      ['pаypal.com', 'refused', 'Not sold'],
      ['ab.io', 'refused', null],
      ['getpaid.com', 'available', null],
    ])
    expect(rows[1]?.note).toBe("We don't sell .edu")
    expect(rows[2]?.note).toMatch(/Mixes Latin and Cyrillic letters/)
    expect(rows[3]?.note).toBe('Too short for .io (3–63 characters)')
  })

  it('prices only an available name, with both prices (N8)', () => {
    const run = finish(
      answer(newRun('getpaid\ntakenbrand\nhotel'), 0, {
        'takenbrand.com': 'registered',
        'hotel.com': 'premium',
      }),
    )
    const rows = resultRows(run)
    expect(rows.map((row) => [row.category, row.price?.registerKobo ?? null])).toEqual([
      ['available', 1_820_000],
      ['taken', null],
      ['premium', null],
    ])
    expect(rows.filter(isSelectable).map((row) => row.domain)).toEqual(['getpaid.com'])
  })

  it('says why a registry refused an international name (FR-S8)', () => {
    const run = finish(answer(newRun('café.app', []), 0, { 'xn--caf-dma.app': 'restricted' }))
    const [row] = resultRows(run)
    expect(row).toMatchObject({ display: 'café.app', category: 'refused' })
    expect(row?.note).toMatch(/did not accept this international name/)
  })

  it('shows a name still waiting as pending, with no badge text of its own', () => {
    const [row] = resultRows(newRun('getpaid'))
    expect(row).toMatchObject({ category: 'pending', status: null })
  })

  it('never offers a name without a price for the cart (N5b)', () => {
    let run = newRun('getpaid')
    const chunk = run.plan.chunks[0]
    if (!chunk) throw new Error('no chunk')
    run = reduceRun(run, {
      type: 'answer',
      id: run.id,
      chunk,
      answer: { ok: true, results: [{ domain: 'getpaid.com', status: 'available' }], prices: {} },
    }) as BulkRun
    const [row] = resultRows(run)
    expect(row?.category).toBe('available')
    expect(row && isSelectable(row)).toBe(false)
  })
})

describe('filters and order', () => {
  const run = finish(
    answer(newRun('zeta\nalpha\ntakenbrand\nhotel\nmid.io\nnot_a_name', ['com']), 0, {
      'takenbrand.com': 'registered',
      'hotel.com': 'premium',
    }),
  )
  const rows = resultRows(run)

  it('filters by available, taken, premium and not checked', () => {
    expect(filterRows(rows, 'all')).toHaveLength(6)
    expect(filterRows(rows, 'available').map((row) => row.display)).toEqual([
      'zeta.com',
      'alpha.com',
      'mid.io',
    ])
    expect(filterRows(rows, 'taken').map((row) => row.display)).toEqual(['takenbrand.com'])
    expect(filterRows(rows, 'premium').map((row) => row.display)).toEqual(['hotel.com'])
    expect(filterRows(rows, 'unchecked')).toEqual([])
  })

  it('orders by name as people read it', () => {
    expect(sortRows(rows, 'name').map((row) => row.display)).toEqual([
      'alpha.com',
      'hotel.com',
      'mid.io',
      'not_a_name',
      'takenbrand.com',
      'zeta.com',
    ])
  })

  it('orders cheapest first, with unpriced rows after, as listed', () => {
    const io = answer(newRun('zeta\nexpensive.io\nalpha'), 0, {})
    expect(sortRows(resultRows(finish(io)), 'price').map((row) => row.display)).toEqual([
      'zeta.com',
      'alpha.com',
      'expensive.io',
    ])
    expect(sortRows(rows, 'price').map((row) => row.display)).toEqual([
      'zeta.com',
      'alpha.com',
      'mid.io',
      'takenbrand.com',
      'hotel.com',
      'not_a_name',
    ])
  })

  it('goes back to the order typed', () => {
    expect(sortRows(sortRows(rows, 'name'), 'list')).toEqual(rows)
  })
})
