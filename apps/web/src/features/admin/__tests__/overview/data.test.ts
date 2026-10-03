import { describe, expect, it } from 'vitest'
import { STATUS_LABEL } from '@/components/common/domain-status-pill'
import {
  dayLabel,
  domainStatusLabel,
  hasPoints,
  monthLabel,
  overviewSeries,
} from '@/features/admin/lib/overview-charts'
import { parseOverview } from '@/features/admin/lib/overview-data'
import { floatState, overviewAnswer } from './fixtures'

describe('reading admin_overview', () => {
  it('takes the answer SQL sends', () => {
    const read = parseOverview(overviewAnswer())
    expect('overview' in read && read.overview.sales.d30.cashKobo).toBe(3_225_000)
  })

  it("takes a test administrator's answer, which has no cron jobs and may have no runs", () => {
    const answer = overviewAnswer()
    const health = { ...answer.health, reconcile: null, fx: null, snapshotAt: null }
    delete (health as { cron?: unknown }).cron
    const read = parseOverview({ ...answer, health })
    expect('overview' in read && read.overview.health.cron).toBeUndefined()
  })

  it('refuses money that is not whole kobo or cents, rather than show a wrong figure (N5)', () => {
    const answer = overviewAnswer()
    expect(
      parseOverview({
        ...answer,
        sales: { ...answer.sales, d7: { ...answer.sales.d7, netKobo: 12.5 } },
      }),
    ).toEqual({ issues: 1 })
    expect(parseOverview({ ...answer, float: floatState({ balanceCents: 43.38 }) })).toEqual({
      issues: 1,
    })
    expect(parseOverview(null)).toMatchObject({ issues: expect.any(Number) })
  })
})

describe('the chart series', () => {
  it('labels Lagos days and months as calendar dates', () => {
    expect(dayLabel('2026-10-03')).toBe('3 Oct')
    expect(monthLabel('2026-11-01')).toBe('Nov 2026')
    expect(dayLabel('not a day')).toBe('not a day')
    expect(monthLabel('soon')).toBe('soon')
  })

  it('words a domain status, and shows an unknown one as itself', () => {
    expect(domainStatusLabel(STATUS_LABEL, 'expired_grace')).toBe('Expired')
    expect(domainStatusLabel(STATUS_LABEL, 'new_state')).toBe('new state')
  })

  it('keeps a day with no snapshot as a gap, not a zero', () => {
    const series = overviewSeries(overviewAnswer() as never, STATUS_LABEL)
    expect(series.balance).toEqual([
      { key: '2026-10-02', label: '2 Oct', value: null },
      { key: '2026-10-03', label: '3 Oct', value: 4338 },
    ])
    expect(series.revenue.map((d) => d.value)).toEqual([1_000_000, 0])
    expect(series.renewals.map((d) => d.label)).toEqual(['Oct 2026', 'Nov 2026'])
    expect(series.statuses.map((d) => d.label)).toEqual(['Active', 'Registering'])
    expect(hasPoints(series.balance)).toBe(true)
    expect(hasPoints([{ value: null }])).toBe(false)
  })
})
