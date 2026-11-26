import { describe, expect, it } from 'vitest'
import type { SearchRow } from '@/features/search/lib/rows'
import { HISTORY_MAX, historyOf, memoOf, TURN_MAX } from '../lib/conversation'

const row = (display: string, status: SearchRow['status'] = 'available'): SearchRow => ({
  domain: display,
  display,
  name: display.split('.')[0] ?? display,
  tld: 'com',
  status,
  price: {
    register: '₦18,300',
    registerYears: 1,
    renew: '₦18,700',
    renewYears: 1,
    renewalIsHigher: true,
    includesIcannFee: true,
    maxPeriod: 10,
  },
})

describe('memoOf (AI phase 5)', () => {
  it('remembers names and outcomes, never a price', () => {
    const names = memoOf({
      kind: 'names',
      ideas: [{ row: row('breadly.com'), why: 'Bread, friendly' }],
      checked: 20,
      tld: 'com',
      language: 'en',
      notSold: null,
    })
    expect(names).toBe('Suggested available .com names: breadly.com.')
    const checked = memoOf({
      kind: 'check',
      rows: [row('a.com'), row('b.com', 'registered')],
      notSold: [],
    })
    expect(checked).toBe('Checked: a.com is free, b.com is not free.')
    const prices = memoOf({
      kind: 'prices',
      prices: [{ tld: 'com', words: '₦18,300 for the first year, then ₦18,700 a year' }],
      notSold: [],
      vatPct: 7.5,
    })
    expect(prices).toBe('Showed prices for .com.')
    for (const memo of [names, checked, prices]) expect(memo).not.toMatch(/₦/)
  })

  it('says when nothing was free, which host was explained, and what help said', () => {
    expect(
      memoOf({ kind: 'names', ideas: [], checked: 18, tld: 'io', language: 'en', notSold: null }),
    ).toBe('None of the 18 .io names tried were free.')
    expect(memoOf({ kind: 'check', rows: [], notSold: ['.zz'] })).toBe(
      'Those extensions are not sold here: .zz.',
    )
    expect(memoOf({ kind: 'search', query: 'a.com' })).toBe(
      'Sent them to the search page for a.com.',
    )
    expect(memoOf({ kind: 'setup', host: 'Wix', preset: null })).toBe(
      'Explained pointing a domain at Wix.',
    )
    expect(
      memoOf({
        kind: 'help',
        help: { answered: true, answer: 'Renew from the domain page.', sources: [] },
      }),
    ).toBe('Renew from the domain page.')
    expect(memoOf({ kind: 'help', help: { answered: false } })).toBe(
      'The help centre did not cover that question.',
    )
    expect(memoOf({ kind: 'other' })).toBe('Said what the assistant can help with.')
  })

  it('lists at most eight names, then counts the rest', () => {
    const ideas = Array.from({ length: 10 }, (_, index) => ({
      row: row(`n${index}.com`),
      why: null,
    }))
    expect(
      memoOf({ kind: 'names', ideas, checked: 20, tld: 'com', language: 'en', notSold: null }),
    ).toBe(
      'Suggested available .com names: n0.com, n1.com, n2.com, n3.com, n4.com, n5.com, n6.com, n7.com and 2 more.',
    )
  })
})

describe('historyOf', () => {
  it('keeps the latest turns, each cut to size', () => {
    const turns = Array.from({ length: HISTORY_MAX + 3 }, (_, index) => ({
      role: index % 2 === 0 ? ('person' as const) : ('assistant' as const),
      text: `${index} ${'x'.repeat(TURN_MAX)}`,
    }))
    const history = historyOf(turns)
    expect(history).toHaveLength(HISTORY_MAX)
    expect(history[0]?.text.startsWith('3 ')).toBe(true)
    expect(history.every((turn) => turn.text.length <= TURN_MAX)).toBe(true)
  })
})
