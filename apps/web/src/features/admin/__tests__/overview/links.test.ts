import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERIOD,
  kpis,
  parsePeriod,
  periodHref,
  periodRange,
  watDay,
} from '@/features/admin/lib/overview-kpis'
import {
  ATTENTION_SPECS,
  attentionTiles,
  nothingNeedsAPerson,
} from '@/features/admin/lib/overview-links'
import type { AttentionCounts } from '@/features/admin/queries/attention'
import { NOW, overview } from './fixtures'

const zero: AttentionCounts = {
  refunds: 0,
  jobs: 0,
  incidents: 0,
  alertsCritical: 0,
  alertsWarning: 0,
  drift: 0,
  stuckOrders: 0,
  pendingWithoutJob: 0,
  emailsFailed: 0,
  ledgerUnexplained: 0,
  presetDrafts: 0,
}

describe('the period', () => {
  it('is 7, 30 or 90 days from the URL, and 30 otherwise', () => {
    expect(parsePeriod('7')).toBe(7)
    expect(parsePeriod(['90', '7'])).toBe(90)
    expect(parsePeriod('30')).toBe(30)
    expect(parsePeriod('365')).toBe(DEFAULT_PERIOD)
    expect(parsePeriod(' 7')).toBe(DEFAULT_PERIOD)
    expect(parsePeriod(undefined)).toBe(30)
  })

  it('leaves the default out of the URL', () => {
    expect(periodHref(30)).toBe('/admin')
    expect(periodHref(7)).toBe('/admin?period=7')
    expect(periodHref(90)).toBe('/admin?period=90')
  })

  it('covers Lagos days, back from today', () => {
    // 23:30 UTC on 2 Oct is already 3 Oct in Lagos.
    expect(watDay(new Date('2026-10-02T23:30:00Z'))).toBe('2026-10-03')
    expect(periodRange(7, NOW)).toEqual({ from: '2026-09-26', to: '2026-10-03' })
    expect(periodRange(90, NOW)).toEqual({ from: '2026-07-05', to: '2026-10-03' })
  })
})

describe('the KPI row', () => {
  it('shows §5.2’s ten figures, in order, for the period chosen', () => {
    const row = kpis(overview(), 7, NOW)
    expect(row.map((kpi) => kpi.label)).toEqual([
      'Cash in',
      'Net sales',
      'VAT collected',
      'Orders paid',
      'Registrations',
      'Renewals',
      'Transfers in',
      'SSL sold',
      'Line refunds',
      'Charge refunds',
    ])
    const byKey = Object.fromEntries(row.map((kpi) => [kpi.key, kpi]))
    expect(byKey.cash?.value).toBe('₦10,750')
    expect(byKey.net?.value).toBe('₦10,000')
    expect(byKey.orders?.value).toBe('2')
    expect(byKey.cash?.hint).toBe('Last 7 days')
    expect(kpis(overview(), 90, NOW).find((kpi) => kpi.key === 'chargeRefunds')?.value).toBe(
      '₦1,200',
    )
  })

  it('links money figures to Money and counts to Orders, over the same days', () => {
    const byKey = Object.fromEntries(kpis(overview(), 7, NOW).map((kpi) => [kpi.key, kpi.href]))
    const week = 'from=2026-09-26&to=2026-10-03'
    for (const key of ['cash', 'net', 'vat', 'lineRefunds', 'chargeRefunds']) {
      expect(byKey[key], key).toBe(`/admin/money?${week}`)
    }
    expect(byKey.orders).toBe(`/admin/orders?${week}`)
  })

  it('says the line counts are 30 days whatever the period, and links them that way (N9b)', () => {
    const row = kpis(overview(), 90, NOW)
    const register = row.find((kpi) => kpi.key === 'register')
    expect(register).toMatchObject({
      value: '4',
      hint: 'Last 30 days',
      href: '/admin/orders?kind=register&from=2026-09-03&to=2026-10-03',
    })
    expect(row.find((kpi) => kpi.key === 'ssl')?.href).toBe(
      '/admin/orders?kind=ssl&from=2026-09-03&to=2026-10-03',
    )
    expect(row.find((kpi) => kpi.key === 'cash')?.hint).toBe('Last 90 days')
  })

  it('never puts a name or an email in a link (N13)', () => {
    for (const kpi of kpis(overview(), 30, NOW)) expect(kpi.href).not.toMatch(/@|%40/)
  })
})

describe('the "needs a person" tiles', () => {
  it('link every queue to its list with the filter that shows what was counted', () => {
    const hrefs = Object.fromEntries(attentionTiles(zero).map((tile) => [tile.key, tile.href]))
    expect(hrefs).toEqual({
      refunds: '/admin/refunds?status=held,failed,needs_attention',
      jobs: '/admin/queue?status=needs_attention',
      alertsCritical: '/admin/alerts?severity=critical',
      drift: '/admin/alerts?tab=drift',
      incidents: '/admin/refunds/incidents?status=unresolved',
      stuckOrders: '/admin/orders?stuck=1',
      pendingWithoutJob: '/admin/queue?tab=pending-without-job',
      emailsFailed: '/admin/emails?status=failed',
      ledgerUnexplained: '/admin/supplier/ledger?status=unexplained',
      presetDrafts: '/admin/settings/presets?status=draft',
    })
  })

  it('covers the ten queues §5.2 names, each once', () => {
    expect(ATTENTION_SPECS).toHaveLength(10)
    expect(new Set(ATTENTION_SPECS.map((spec) => spec.key)).size).toBe(10)
  })

  it('stays quiet at zero, and takes its tone when something waits', () => {
    const tiles = attentionTiles({ ...zero, jobs: 2, refunds: 1, presetDrafts: 1 })
    const tone = Object.fromEntries(tiles.map((tile) => [tile.key, tile.tone]))
    expect(tone).toMatchObject({ jobs: 'danger', refunds: 'warning', presetDrafts: 'info' })
    expect(tone.drift).toBe('neutral')
    expect(tiles.find((tile) => tile.key === 'jobs')?.value).toBe(2)
  })

  it('adds open warnings to the critical alerts tile', () => {
    const tile = (counts: AttentionCounts) =>
      attentionTiles(counts).find((t) => t.key === 'alertsCritical')
    expect(tile({ ...zero, alertsWarning: 3 })?.hint).toBe('Plus 3 warnings')
    expect(tile({ ...zero, alertsWarning: 1 })?.hint).toBe('Plus 1 warning')
    expect(tile(zero)?.hint).toBeUndefined()
  })

  it('says nothing needs a person only when every count, warnings too, is zero', () => {
    expect(nothingNeedsAPerson(zero)).toBe(true)
    expect(nothingNeedsAPerson({ ...zero, alertsWarning: 1 })).toBe(false)
    expect(nothingNeedsAPerson({ ...zero, presetDrafts: 1 })).toBe(false)
  })
})
