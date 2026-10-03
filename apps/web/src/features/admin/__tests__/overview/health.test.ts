import { describe, expect, it } from 'vitest'
import type { CronJob, Health } from '@/features/admin/lib/overview-data'
import {
  catalogueHealth,
  cronHealth,
  fxHealth,
  gatewayHealth,
  HEALTH_LIMITS,
  healthItems,
  ledgerHealth,
  reconcileHealth,
  snapshotHealth,
} from '@/features/admin/lib/overview-health'
import { daysAgo, hoursAgo, minutesAgo, NOW, overview } from './fixtures'

describe('the gateway tile', () => {
  it('is OK while its own side beat under 15 minutes ago', () => {
    const live = [{ name: 'gateway:production', beatAt: minutesAgo(14), outcome: null }]
    expect(gatewayHealth(live, 'live', NOW)).toMatchObject({
      tone: 'ok',
      word: 'OK',
      detail: 'Last seen 14 min ago',
    })
  })

  it('is late at 15 minutes, and reads only its own side', () => {
    const beats = [
      { name: 'gateway:production', beatAt: minutesAgo(1) },
      { name: 'gateway:ote', beatAt: minutesAgo(HEALTH_LIMITS.gatewayMinutes) },
    ]
    expect(gatewayHealth(beats, 'test', NOW)).toMatchObject({ tone: 'danger', word: 'Late' })
    expect(gatewayHealth(beats, 'live', NOW).word).toBe('OK')
  })

  it('says when no gateway has reported on the side', () => {
    expect(gatewayHealth([], 'test', NOW)).toMatchObject({
      tone: 'neutral',
      word: 'No record',
      detail: 'No sandbox gateway has reported on the test side',
    })
    expect(gatewayHealth([], 'live', NOW).detail).toBe('The gateway has not reported')
  })
})

describe('the registry reconcile tile', () => {
  it('is OK when the last run finished under 2 hours ago without an error', () => {
    expect(reconcileHealth({ finishedAt: minutesAgo(119), error: null }, NOW)).toMatchObject({
      tone: 'ok',
      detail: 'Last finished 1 h ago',
    })
  })

  it('is late from 2 hours, and failing on an error whatever its age', () => {
    expect(reconcileHealth({ finishedAt: hoursAgo(2), error: null }, NOW)).toMatchObject({
      tone: 'warning',
      word: 'Late',
    })
    const failed = reconcileHealth({ finishedAt: minutesAgo(5), error: 'API_301 forbidden' }, NOW)
    expect(failed).toMatchObject({ tone: 'danger', word: 'Failing' })
    // The registry's own words stay on the alerts page (N10).
    expect(failed.detail).not.toContain('API_301')
  })

  it('has no record before a run has finished', () => {
    expect(reconcileHealth(null, NOW).word).toBe('No record')
    expect(reconcileHealth({ finishedAt: null, error: null }, NOW).word).toBe('No record')
  })
})

describe('the catalogue sync tiles', () => {
  const beat = (outcome: string, at: string) => [
    { name: 'catalogue:production', beatAt: at, outcome },
  ]

  it('is OK under 8 days old when the run was not refused', () => {
    expect(catalogueHealth(beat('written', daysAgo(7.9)), 'catalogue', 'live', NOW)).toMatchObject({
      tone: 'ok',
      label: 'Catalogue sync',
    })
  })

  it('is late at 8 days, and refused or failing whatever its age', () => {
    expect(
      catalogueHealth(
        beat('written', daysAgo(HEALTH_LIMITS.catalogueDays)),
        'catalogue',
        'live',
        NOW,
      ),
    ).toMatchObject({ tone: 'warning', word: 'Late' })
    expect(catalogueHealth(beat('refused', daysAgo(1)), 'catalogue', 'live', NOW)).toMatchObject({
      tone: 'danger',
      word: 'Refused',
    })
    expect(catalogueHealth(beat('failed', daysAgo(1)), 'catalogue', 'live', NOW)).toMatchObject({
      tone: 'danger',
      word: 'Failing',
    })
  })

  it('reads the SSL catalogue from its own heartbeat', () => {
    const beats = [{ name: 'ssl_catalogue:production', beatAt: daysAgo(9), outcome: 'written' }]
    expect(catalogueHealth(beats, 'ssl_catalogue', 'live', NOW)).toMatchObject({
      label: 'SSL catalogue sync',
      word: 'Late',
    })
    expect(catalogueHealth(beats, 'catalogue', 'live', NOW).word).toBe('No record')
  })

  it('says the syncs report on the live side when the test side has none', () => {
    expect(catalogueHealth([], 'catalogue', 'test', NOW)).toMatchObject({
      tone: 'neutral',
      word: 'Live only',
    })
  })
})

describe('the supplier ledger tile', () => {
  const beat = (outcome: string, at = minutesAgo(5)) => [
    { name: 'supplier_ledger:production', beatAt: at, outcome },
  ]

  it('is OK when the last successful read is under 3 hours old', () => {
    expect(ledgerHealth(beat('ok'), { ledgerReadAt: minutesAgo(179) }, 'live', NOW)).toMatchObject({
      tone: 'ok',
      detail: 'Last read 2 h ago',
    })
  })

  it('stays OK after one failed attempt, and says so', () => {
    const item = ledgerHealth(beat('failed'), { ledgerReadAt: minutesAgo(70) }, 'live', NOW)
    expect(item).toMatchObject({
      tone: 'ok',
      detail: 'Last read 1 h ago; the latest attempt failed',
    })
  })

  it('is failing when the last good read is 3 hours old and the latest failed', () => {
    expect(ledgerHealth(beat('failed'), { ledgerReadAt: hoursAgo(3) }, 'live', NOW)).toMatchObject({
      tone: 'danger',
      word: 'Failing',
      detail: 'Last read 3 h ago',
    })
    expect(ledgerHealth(beat('failed'), { ledgerReadAt: null }, 'live', NOW).detail).toBe(
      'No successful read yet',
    )
  })

  it('is late when reads simply stopped', () => {
    expect(
      ledgerHealth(beat('ok', hoursAgo(4)), { ledgerReadAt: hoursAgo(4) }, 'live', NOW),
    ).toMatchObject({ tone: 'warning', word: 'Late' })
  })

  it('falls back to an ok heartbeat when the float has no read time', () => {
    expect(ledgerHealth(beat('ok'), null, 'live', NOW).word).toBe('OK')
  })

  it('has no record on a side the ledger is not read for', () => {
    expect(ledgerHealth(beat('ok'), { ledgerReadAt: null }, 'test', NOW)).toMatchObject({
      word: 'No record',
    })
  })
})

describe('the balance snapshot tile', () => {
  it('is OK under 30 minutes old, late after', () => {
    expect(snapshotHealth(minutesAgo(29), NOW).word).toBe('OK')
    expect(snapshotHealth(minutesAgo(HEALTH_LIMITS.snapshotMinutes), NOW)).toMatchObject({
      tone: 'warning',
      word: 'Late',
      detail: 'Last taken 30 min ago',
    })
    expect(snapshotHealth(null, NOW).word).toBe('No record')
  })
})

describe('the FX tile', () => {
  const fx = (overrides: Partial<NonNullable<Health['fx']>> = {}) => ({
    activeFrom: hoursAgo(20),
    costingRate: 1328.0977,
    pendingCount: 0,
    pendingOldestAt: null,
    ...overrides,
  })

  it('gives the active rate and its age, OK under 48 hours with nothing held', () => {
    expect(fxHealth(fx(), NOW)).toMatchObject({
      tone: 'ok',
      detail: '₦1,328.10 to the dollar, set 20 h ago',
    })
  })

  it('counts rates held for review', () => {
    expect(fxHealth(fx({ pendingCount: 2, pendingOldestAt: daysAgo(13) }), NOW)).toMatchObject({
      tone: 'warning',
      word: 'Review',
      detail: '₦1,328.10 to the dollar, set 20 h ago; 2 held for review',
    })
  })

  it('is late when the daily job has not set a rate in 48 hours', () => {
    expect(fxHealth(fx({ activeFrom: hoursAgo(HEALTH_LIMITS.fxHours) }), NOW)).toMatchObject({
      word: 'Late',
      detail: '₦1,328.10 to the dollar, set 2 days ago',
    })
  })

  it('says when there is no active rate', () => {
    expect(
      fxHealth(fx({ activeFrom: null, costingRate: null, pendingCount: 1 }), NOW),
    ).toMatchObject({
      tone: 'danger',
      word: 'No rate',
      detail: 'No active exchange rate; 1 held for review',
    })
    expect(fxHealth(null, NOW).word).toBe('No rate')
  })
})

describe('the scheduled jobs tile', () => {
  const job = (name: string, overrides: Partial<CronJob> = {}): CronJob => ({
    job: name,
    schedule: '0 * * * *',
    lastRunAt: hoursAgo(1),
    lastStatus: 'succeeded',
    lastSuccessAt: hoursAgo(1),
    ...overrides,
  })

  it('is OK when no latest run failed and the notices ran within 26 hours', () => {
    const jobs = [
      job('email-notices', { lastSuccessAt: hoursAgo(25.9) }),
      job('purge-stale-carts'),
      // Scheduled, never run yet: not a failure.
      job('admin-metrics-daily', { lastRunAt: null, lastStatus: null, lastSuccessAt: null }),
    ]
    expect(cronHealth(jobs, false, NOW)).toMatchObject({
      tone: 'ok',
      word: 'OK',
      detail: '3 jobs, none failing',
    })
  })

  it('names every job whose latest run failed', () => {
    const jobs = [
      job('email-notices'),
      job('purge-stale-carts', { lastStatus: 'failed' }),
      job('expire-unpaid-orders', { lastStatus: 'failed' }),
    ]
    expect(cronHealth(jobs, false, NOW)).toMatchObject({
      tone: 'warning',
      word: 'Failing',
      detail: 'Last run failed: purge-stale-carts, expire-unpaid-orders',
    })
  })

  it('is critical when the expiry notices have not succeeded in 26 hours (ERRP)', () => {
    const stale = cronHealth(
      [job('email-notices', { lastStatus: 'failed', lastSuccessAt: hoursAgo(26) })],
      false,
      NOW,
    )
    expect(stale.tone).toBe('danger')
    expect(stale.detail).toBe(
      'Expiry notices (email-notices): last succeeded 2 Oct 2026, 08:00 WAT. Last run failed: email-notices',
    )
    expect(cronHealth([job('purge-stale-carts')], false, NOW).detail).toBe(
      'Expiry notices (email-notices): no successful run recorded',
    )
  })

  it('is hidden from a test administrator, who is sent no cron jobs', () => {
    expect(cronHealth(undefined, true, NOW)).toMatchObject({
      tone: 'neutral',
      word: 'Hidden',
      detail: 'Not shown to test administrators',
    })
    expect(cronHealth(undefined, false, NOW).word).toBe('No record')
    expect(cronHealth([], false, NOW).detail).toBe('No scheduled jobs found')
  })
})

describe('the health strip', () => {
  it('lists every service in order, from one overview answer', () => {
    const { health, float } = overview()
    const items = healthItems({ health, float, side: 'live', testOnly: false, now: NOW })
    expect(items.map((item) => item.key)).toEqual([
      'gateway',
      'reconcile',
      'catalogue',
      'ssl_catalogue',
      'ledger',
      'snapshot',
      'fx',
      'cron',
    ])
    expect(items.every((item) => item.word === 'OK')).toBe(true)
  })
})
