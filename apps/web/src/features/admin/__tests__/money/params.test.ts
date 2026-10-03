import { describe, expect, it } from 'vitest'
import {
  addDays,
  autoGrain,
  bucketLabel,
  bucketSpan,
  byGrain,
  daysBetween,
  formatDay,
  formatSpan,
  grainHref,
  lagosDay,
  lastYearHref,
  MAX_SPAN_DAYS,
  moneyHref,
  ordersHref,
  parseMoneyParams,
} from '@/features/admin/lib/money-params'
import { NOW } from './fixtures'

describe('the date range (§9 link contract: ?from=YYYY-MM-DD&to=YYYY-MM-DD)', () => {
  it('opens on the last 30 days to today, in Lagos, by day', () => {
    expect(parseMoneyParams({}, NOW)).toEqual({
      from: '2026-09-03',
      to: '2026-10-03',
      grain: 'day',
      grainChosen: false,
      clamped: false,
    })
  })

  it("takes the overview's link as it is", () => {
    const params = parseMoneyParams({ from: '2026-09-26', to: '2026-10-03' }, NOW)
    expect(params).toMatchObject({ from: '2026-09-26', to: '2026-10-03', grain: 'day' })
  })

  it('reads the day in Lagos, an hour ahead of UTC', () => {
    // 23:30 UTC on 2 Oct is 00:30 on 3 Oct in Lagos.
    expect(lagosDay(new Date('2026-10-02T23:30:00Z'))).toBe('2026-10-03')
  })

  it('fills a missing end: to today from a start, 30 days back from an end', () => {
    expect(parseMoneyParams({ from: '2026-09-01' }, NOW)).toMatchObject({
      from: '2026-09-01',
      to: '2026-10-03',
    })
    expect(parseMoneyParams({ to: '2026-06-30' }, NOW)).toMatchObject({
      from: '2026-05-31',
      to: '2026-06-30',
    })
    // A start after today ends on itself rather than before it.
    expect(parseMoneyParams({ from: '2026-12-01' }, NOW)).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-01',
    })
  })

  it('puts dates given the wrong way round in order', () => {
    expect(parseMoneyParams({ from: '2026-10-03', to: '2026-09-01' }, NOW)).toMatchObject({
      from: '2026-09-01',
      to: '2026-10-03',
    })
  })

  it('ignores a date that is not a real one, and takes the first of a repeated value', () => {
    expect(parseMoneyParams({ from: '2026-02-30', to: 'yesterday' }, NOW)).toMatchObject({
      from: '2026-09-03',
      to: '2026-10-03',
    })
    expect(parseMoneyParams({ from: ['2026-09-10', '2026-01-01'] }, NOW)).toMatchObject({
      from: '2026-09-10',
    })
  })

  it('never asks SQL for more than it allows (admin:bad_range), and says so', () => {
    const params = parseMoneyParams({ from: '2020-01-01', to: '2026-10-03' }, NOW)
    expect(params.clamped).toBe(true)
    expect(params.to).toBe('2026-10-03')
    expect(daysBetween(params.from, params.to)).toBe(MAX_SPAN_DAYS)
    expect(
      parseMoneyParams({ from: addDays('2026-10-03', -MAX_SPAN_DAYS), to: '2026-10-03' }, NOW)
        .clamped,
    ).toBe(false)
  })
})

describe('the grain', () => {
  it('follows the span when none is chosen: days, then weeks, then months', () => {
    expect(autoGrain(0)).toBe('day')
    expect(autoGrain(92)).toBe('day')
    expect(autoGrain(93)).toBe('week')
    expect(autoGrain(366)).toBe('week')
    expect(autoGrain(367)).toBe('month')
    expect(parseMoneyParams({ from: '2025-10-03', to: '2026-10-03' }, NOW).grain).toBe('week')
    expect(parseMoneyParams({ from: '2024-10-03', to: '2026-10-03' }, NOW).grain).toBe('month')
  })

  it('keeps a chosen grain, and drops one SQL does not know', () => {
    expect(parseMoneyParams({ grain: 'month' }, NOW)).toMatchObject({
      grain: 'month',
      grainChosen: true,
    })
    expect(parseMoneyParams({ grain: 'hour' }, NOW)).toMatchObject({
      grain: 'day',
      grainChosen: false,
    })
  })

  it('links each grain over the same dates', () => {
    const params = parseMoneyParams({ from: '2026-09-01', to: '2026-09-30' }, NOW)
    expect(grainHref(params, 'week')).toBe('/admin/money?from=2026-09-01&to=2026-09-30&grain=week')
    expect(moneyHref({ from: '2026-09-01', to: '2026-09-30' })).toBe(
      '/admin/money?from=2026-09-01&to=2026-09-30',
    )
    expect(lastYearHref(NOW)).toBe('/admin/money?from=2025-10-03&to=2026-10-03&grain=month')
    expect(byGrain('week')).toBe('by week')
  })

  it('opens the orders behind a figure, by kind when it is one the list knows', () => {
    const range = { from: '2026-09-01', to: '2026-09-30' }
    expect(ordersHref(range)).toBe('/admin/orders?from=2026-09-01&to=2026-09-30')
    expect(ordersHref(range, 'ssl')).toBe('/admin/orders?kind=ssl&from=2026-09-01&to=2026-09-30')
    expect(ordersHref(range, 'gift_card')).toBe('/admin/orders?from=2026-09-01&to=2026-09-30')
  })
})

describe('bucket names', () => {
  const range = { from: '2026-09-02', to: '2026-10-03' }

  it('names a day by its date', () => {
    expect(formatDay('2026-10-03')).toBe('3 Oct 2026')
    expect(bucketLabel('2026-10-03', 'day', range)).toBe('3 Oct 2026')
  })

  it('names a Monday-started week by the days it covers inside the dates', () => {
    // SQL's first week starts Monday 31 Aug, before the range opens on 2 Sept.
    expect(bucketSpan('2026-08-31', 'week', range)).toEqual({
      start: '2026-09-02',
      end: '2026-09-06',
      partial: true,
    })
    expect(bucketLabel('2026-08-31', 'week', range)).toBe('2–6 Sept 2026')
    expect(bucketLabel('2026-09-28', 'week', range)).toBe('28 Sept – 3 Oct 2026')
    expect(bucketSpan('2026-09-07', 'week', range).partial).toBe(false)
  })

  it('names a whole month by name, and a cut one by its days', () => {
    expect(bucketLabel('2026-09-01', 'month', { from: '2026-09-01', to: '2026-10-03' })).toBe(
      'September 2026',
    )
    expect(bucketLabel('2026-10-01', 'month', { from: '2026-09-01', to: '2026-10-03' })).toBe(
      '1–3 Oct 2026',
    )
    // February in a leap year ends on the 29th.
    expect(bucketSpan('2028-02-01', 'month', { from: '2028-01-01', to: '2028-12-31' }).end).toBe(
      '2028-02-29',
    )
  })

  it('writes a span across years in full', () => {
    expect(formatSpan('2025-12-29', '2026-01-04')).toBe('29 Dec 2025 – 4 Jan 2026')
    expect(formatSpan('2026-10-03', '2026-10-03')).toBe('3 Oct 2026')
  })
})
