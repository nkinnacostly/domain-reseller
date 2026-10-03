import { describe, expect, it } from 'vitest'
import {
  closeSeries,
  hasActivity,
  lagosDays,
  lagosToday,
  ledgerSeries,
} from '@/features/admin/lib/supplier-charts'

describe('the 90-day range', () => {
  it('ends today in Lagos, oldest first', () => {
    const now = new Date('2026-10-03T23:30:00Z')
    expect(lagosToday(now)).toBe('2026-10-04')
    const days = lagosDays(now, 90)
    expect(days).toHaveLength(90)
    expect(days[0]).toBe('2026-07-07')
    expect(days.at(-1)).toBe('2026-10-04')
  })
})

describe('the balance at each day’s close', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03']

  it('takes the rollup’s closes, leaves a missing day as a gap, and today from the snapshot', () => {
    const series = closeSeries(days, [{ day: '2026-10-01', closeCents: 738 }], {
      balanceCents: 4338,
      takenAt: '2026-10-03T13:00:00Z',
    })
    expect(series).toEqual([
      { key: '2026-10-01', label: '1 Oct', value: 738 },
      { key: '2026-10-02', label: '2 Oct', value: null },
      { key: '2026-10-03', label: '3 Oct', value: 4338 },
    ])
  })

  it('never puts an older snapshot on today', () => {
    const series = closeSeries(days, [], { balanceCents: 4338, takenAt: '2026-10-02T13:00:00Z' })
    expect(series.at(-1)?.value).toBeNull()
    expect(closeSeries(days, [], { balanceCents: null, takenAt: null }).at(-1)?.value).toBeNull()
  })
})

describe('debits and credits per day', () => {
  it('fills every day: no entry means nothing spent or received', () => {
    const { debits, credits } = ledgerSeries(
      ['2026-10-01', '2026-10-02'],
      [{ day: '2026-10-02', debitCents: 1131, creditCents: 3600, closeCents: 4338 }],
    )
    expect(debits.map((d) => d.value)).toEqual([0, 1131])
    expect(credits.map((d) => d.value)).toEqual([0, 3600])
    expect(hasActivity(debits)).toBe(true)
    expect(hasActivity(ledgerSeries(['2026-10-01'], []).debits)).toBe(false)
  })
})
