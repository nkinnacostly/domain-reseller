import { adminHrefForAlertKey } from '@dr/shared/admin'
import { describe, expect, it } from 'vitest'
import {
  ALERT_KIND_LABEL,
  alertKindLabel,
  cronTone,
  DRIFT_KIND_LABEL,
  DRIFT_NOTE,
  destinationLabel,
  driftComparison,
  driftKindLabel,
  formatSeconds,
  heartbeatLabel,
  ledgerHeartbeatName,
  notifiedLabel,
  OPEN_NOTE,
  outcomeTone,
  runOutcome,
  TEST_SIDE_NOTE,
} from '@/features/admin/lib/alerts-copy'

/** The alerts page's words (ADMIN-SPEC §5.2, B5). */

describe('the notes', () => {
  it('say exactly what the spec says', () => {
    expect(OPEN_NOTE).toBe(
      'Alerts close by themselves once the condition is gone. There is no dismiss.',
    )
    expect(TEST_SIDE_NOTE).toBe(
      'Test-side alerts are not re-evaluated by the running gateway; they may be out of date.',
    )
    expect(DRIFT_NOTE).toBe('Drift closes when the next complete reconcile no longer finds it.')
  })
})

describe('alert kinds', () => {
  it('words every kind the alert conditions raise', () => {
    for (const [kind, words] of Object.entries(ALERT_KIND_LABEL)) {
      expect(alertKindLabel(kind)).toBe(words)
      expect(words).not.toContain('_')
    }
  })

  it('names the drift inside a drift alert, and shows an unknown kind as itself', () => {
    expect(alertKindLabel('drift_unknown_domain')).toBe('Registry drift: not in our records')
    expect(alertKindLabel('drift_brand_new')).toBe('Registry drift: brand new')
    expect(alertKindLabel('something_new')).toBe('something new')
    expect(alertKindLabel(null)).toBe('—')
    expect(driftKindLabel('supplier_renewed')).toBe(DRIFT_KIND_LABEL.supplier_renewed)
    expect(driftKindLabel('odd_kind')).toBe('odd kind')
    expect(driftKindLabel(undefined)).toBe('—')
  })
})

describe('ours against the registry, from a drift row', () => {
  it('reads each kind the reconcile writes', () => {
    expect(
      driftComparison('supplier_renewed', {
        ours: '2027-01-10T08:00:00Z',
        registry: '2028-01-10T08:00:00Z',
      }),
    ).toEqual({ ours: 'Expires 10 Jan 2027', registry: 'Expires 10 Jan 2028' })
    expect(
      driftComparison('expiry_moved_earlier', {
        ours: '2027-01-10T08:00:00Z',
        registry: '2026-12-01T08:00:00Z',
      }).registry,
    ).toBe('Expires 1 Dec 2026')
    expect(
      driftComparison('status_mismatch', { local_status: 'active', registry_status: 'clientHold' }),
    ).toEqual({ ours: 'Status active', registry: 'Status clientHold' })
    expect(driftComparison('missing_at_registry', { local_status: 'expired_grace' })).toEqual({
      ours: 'Status expired grace',
      registry: 'No record',
    })
    expect(
      driftComparison('unknown_domain', {
        registry_status: 'Active',
        expires_at: '2027-09-23T08:44:10.058Z',
        renewal_mode: 'AutoRenew',
      }),
    ).toEqual({
      ours: 'No record',
      registry: 'Status Active, expires 23 Sept 2027, renewal mode AutoRenew',
    })
    expect(
      driftComparison('registered_but_failed', {
        registry_status: 'Active',
        expires_at: '2027-09-23T08:44:10.058Z',
      }),
    ).toEqual({ ours: 'Failed', registry: 'Status Active, expires 23 Sept 2027' })
    expect(
      driftComparison('supplier_may_renew', {
        expires_at: '2026-11-01T00:00:00Z',
        renewal_mode: 'AutoRenew',
      }),
    ).toEqual({ ours: 'Auto-renew off, expires 1 Nov 2026', registry: 'Renewal mode AutoRenew' })
  })

  it('shows a dash, never raw JSON, for an unknown kind or a missing field', () => {
    expect(driftComparison('new_kind', { anything: 'x' })).toEqual({ ours: '—', registry: '—' })
    expect(driftComparison('status_mismatch', null)).toEqual({ ours: '—', registry: '—' })
    expect(driftComparison('supplier_renewed', { ours: 'not a date', registry: 42 })).toEqual({
      ours: '—',
      registry: '—',
    })
    expect(driftComparison('supplier_may_renew', {})).toEqual({
      ours: 'Auto-renew off',
      registry: '—',
    })
  })

  it('keeps a long registry value short', () => {
    const { registry } = driftComparison('status_mismatch', { registry_status: 'x'.repeat(200) })
    expect(registry.length).toBeLessThanOrEqual(70)
    expect(registry.endsWith('…')).toBe(true)
  })
})

describe('health words', () => {
  it('names each background service and its side', () => {
    expect(heartbeatLabel('gateway:production')).toBe('Gateway (live)')
    expect(heartbeatLabel('gateway:ote')).toBe('Gateway (sandbox)')
    expect(heartbeatLabel('supplier_ledger:production')).toBe('Supplier ledger sync (live)')
    expect(heartbeatLabel('catalogue:production')).toBe('Price list sync (live)')
    expect(heartbeatLabel('ssl_catalogue:production')).toBe('Certificate list sync (live)')
    expect(heartbeatLabel('preset_check')).toBe('preset check')
    expect(heartbeatLabel('worker:eu')).toBe('worker (eu)')
    expect(ledgerHeartbeatName('live')).toBe('supplier_ledger:production')
    expect(ledgerHeartbeatName('test')).toBe('supplier_ledger:ote')
  })

  it('shows only the code of a failed registry check, never its message (N10)', () => {
    expect(
      runOutcome({ finishedAt: null, error: 'API_301: Your IP 1.2.3.4 is not allowed' }),
    ).toEqual({ label: 'Failed (API_301)', tone: 'danger' })
    expect(runOutcome({ finishedAt: null, error: 'Portfolio larger than expected' })).toEqual({
      label: 'Failed',
      tone: 'danger',
    })
    expect(runOutcome({ finishedAt: null, error: null })).toEqual({
      label: 'Running',
      tone: 'info',
    })
    expect(runOutcome({ finishedAt: '2026-10-03T09:00:00Z', error: null })).toEqual({
      label: 'Done',
      tone: 'ok',
    })
  })

  it('tones outcomes and cron states, with words carrying the meaning', () => {
    expect(outcomeTone('ok')).toBe('ok')
    expect(outcomeTone('written')).toBe('ok')
    expect(outcomeTone('failed')).toBe('danger')
    expect(outcomeTone('refused')).toBe('warning')
    expect(outcomeTone('odd')).toBe('neutral')
    expect(outcomeTone(null)).toBe('neutral')
    expect(cronTone('succeeded')).toBe('ok')
    expect(cronTone('failed')).toBe('danger')
    expect(cronTone('running')).toBe('info')
    expect(cronTone(null)).toBe('neutral')
  })

  it('writes lengths and counts plainly', () => {
    expect(formatSeconds(null)).toBe('—')
    expect(formatSeconds(Number.NaN)).toBe('—')
    expect(formatSeconds(0.5)).toBe('0.5 s')
    expect(formatSeconds(42.4)).toBe('42 s')
    expect(formatSeconds(600)).toBe('10 min')
    expect(notifiedLabel(0)).toBe('Not sent')
    expect(notifiedLabel(1)).toBe('Once')
    expect(notifiedLabel(4)).toBe('4 times')
  })
})

describe('where an alert links', () => {
  const uuid = '0b6a52a1-55c4-4f0e-9a3e-2b8c1d2e3f40'
  it('names every page adminHrefForAlertKey can send a row to', () => {
    const cases: [string, string][] = [
      [`job:${uuid}`, 'Job'],
      [`ssl_job:${uuid}`, 'Certificate job'],
      [`ssl_status:${uuid}`, 'Certificate'],
      [`order_stuck:${uuid}`, 'Order'],
      [`refund:${uuid}`, 'Refund'],
      ['incident:12', 'Incidents'],
      ['drift:7', 'Drift list'],
      ['cron_failed:email-notices', 'Health'],
      ['reconcile_stale:true', 'Health'],
      ['float_cover:live', 'Supplier'],
      ['catalogue_sync:catalogue:production', 'Price list'],
      [`preset_hidden:${uuid}`, 'Host preset'],
      ['email_failed:1', 'Emails'],
      ['notice_bounced:1', 'Emails'],
      [`ledger_missing:${uuid}`, 'Orders'],
      [`ledger_unexplained:${uuid}`, 'Supplier ledger'],
      ['admin_changed:3', 'Admins'],
      ['admin_burst:owner', 'Audit log'],
      ['admin_limit_raised:9', 'Audit log'],
      ['something_new:1', 'Alerts'],
    ]
    for (const [key, words] of cases) {
      expect(destinationLabel(adminHrefForAlertKey(key)), key).toBe(words)
    }
    expect(destinationLabel('/somewhere/else')).toBe('Open')
  })
})
