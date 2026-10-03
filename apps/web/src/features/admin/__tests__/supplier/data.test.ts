import { describe, expect, it } from 'vitest'
import { parseLedgerDays, parseSupplierFloat } from '@/features/admin/lib/supplier-data'
import { floatAnswer, TRACE } from './fixtures'

describe('what admin_float answers', () => {
  it('reads the float and its top-ups in whole cents and kobo', () => {
    const parsed = parseSupplierFloat(floatAnswer())
    expect('issues' in parsed).toBe(false)
    if ('issues' in parsed) return
    expect(parsed.balanceCents).toBe(4338)
    expect(parsed.topups).toHaveLength(2)
    expect(parsed.topups[0]).toMatchObject({ traceId: TRACE, usdCents: 3600, id: null })
  })

  it('fails the read on a float amount rather than show a wrong figure (N5)', () => {
    expect(parseSupplierFloat(floatAnswer({ balanceCents: 43.38 }))).toEqual({ issues: 1 })
    expect(parseSupplierFloat({ side: 'elsewhere' })).toMatchObject({ issues: expect.any(Number) })
  })

  it('reads an unreadable top-up list as none, keeping the balance', () => {
    const parsed = parseSupplierFloat(floatAnswer({ topups: [{ usdCents: 1.5 }] }))
    expect('issues' in parsed ? null : parsed.topups).toEqual([])
  })
})

describe('what admin_ledger_daily answers', () => {
  it('reads each Lagos day as cents', () => {
    expect(
      parseLedgerDays([
        { day: '2026-10-02', debit_cents: 1131, credit_cents: 3600, close_cents: 4338 },
        { day: '2026-10-03T00:00:00', debit_cents: 0, credit_cents: 0, close_cents: null },
      ]),
    ).toEqual([
      { day: '2026-10-02', debitCents: 1131, creditCents: 3600, closeCents: 4338 },
      { day: '2026-10-03', debitCents: 0, creditCents: 0, closeCents: null },
    ])
  })

  it('is null for a shape SQL did not promise', () => {
    expect(parseLedgerDays([{ day: 'today', debit_cents: 1 }])).toBeNull()
    expect(parseLedgerDays({})).toBeNull()
  })
})
