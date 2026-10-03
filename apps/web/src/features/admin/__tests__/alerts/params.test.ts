import { adminHrefForAlertKey } from '@dr/shared/admin'
import { describe, expect, it } from 'vitest'
import {
  type AlertsParams,
  alertsListHref,
  alertsSortHref,
  alertsTabHref,
  historyKindHref,
  historyStateHref,
  historyWindow,
  openSeverityHref,
  parseAlertKind,
  parseAlertsParams,
  parseAlertTab,
} from '@/features/admin/lib/alerts-params'

/** The alerts page's URL (ADMIN-SPEC §5.2, B5 unit: tab params). */

type History = Extract<AlertsParams, { tab: 'history' }>
const history = (query: string) => parseAlertsParams(new URLSearchParams(query)) as History

describe('the alerts tab', () => {
  it('opens on Open when no tab or an unknown one is asked for', () => {
    expect(parseAlertTab(undefined)).toBe('open')
    expect(parseAlertTab('')).toBe('open')
    expect(parseAlertTab('dismissed')).toBe('open')
    expect(parseAlertTab('HISTORY')).toBe('open')
    expect(parseAlertsParams({}).tab).toBe('open')
    expect(parseAlertsParams({ tab: ['drift', 'health'] }).tab).toBe('drift')
  })

  it('knows the four tabs, and the two the Telegram links name are the ones it serves', () => {
    for (const tab of ['open', 'history', 'drift', 'health'] as const) {
      expect(parseAlertsParams({ tab }).tab).toBe(tab)
    }
    // adminHrefForAlertKey sends drift and health alerts to these exact addresses.
    expect(alertsTabHref('drift')).toBe(adminHrefForAlertKey('drift:12'))
    expect(alertsTabHref('health')).toBe(adminHrefForAlertKey('cron_failed:email-notices'))
    expect(alertsTabHref('open')).toBe('/admin/alerts')
    expect(alertsTabHref('history')).toBe('/admin/alerts?tab=history')
  })

  it('reads Health with no list values at all', () => {
    expect(parseAlertsParams({ tab: 'health', page: '3', sort: 'x' })).toEqual({ tab: 'health' })
  })
})

describe('the open list', () => {
  it('puts critical first by default and pages fifty at a time', () => {
    const params = parseAlertsParams({})
    if (params.tab !== 'open') throw new Error('not open')
    expect(params.list).toMatchObject({ sort: 'severity', dir: 'asc', page: 1, per: 50 })
  })

  it('drops a sort it does not know, and links keep the tab out of the default', () => {
    const params = parseAlertsParams({ sort: 'summary', page: '2' })
    if (params.tab !== 'open') throw new Error('not open')
    expect(params.list.sort).toBe('severity')
    expect(alertsListHref(params, { page: 3 })).toBe('/admin/alerts?page=3')
    expect(alertsListHref(params, { page: 1 })).toBe('/admin/alerts')
  })

  it('flips the current sort and starts another descending, back on page 1', () => {
    const params = parseAlertsParams({ page: '4' })
    if (params.tab !== 'open') throw new Error('not open')
    expect(alertsSortHref(params, 'severity')).toBe('/admin/alerts?dir=desc')
    expect(alertsSortHref(params, 'last_seen')).toBe('/admin/alerts?sort=last_seen&dir=desc')
  })
})

describe('the open list by severity (§9: the overview links ?severity=critical)', () => {
  it('opens on the critical alerts for ?severity=critical, and keeps it in every link', () => {
    const params = parseAlertsParams({ severity: 'critical', page: '2' })
    if (params.tab !== 'open') throw new Error('not open')
    expect(params.severity).toBe('critical')
    expect(alertsListHref(params, { page: 3 })).toBe('/admin/alerts?page=3&severity=critical')
    expect(alertsSortHref(params, 'last_seen')).toBe(
      '/admin/alerts?sort=last_seen&dir=desc&severity=critical',
    )
  })

  it('toggles one severity chip, back on page 1, and drops a severity it does not know', () => {
    const params = parseAlertsParams({ severity: 'critical', page: '2' })
    if (params.tab !== 'open') throw new Error('not open')
    expect(openSeverityHref(params, 'critical')).toBe('/admin/alerts')
    expect(openSeverityHref(params, 'warning')).toBe('/admin/alerts?severity=warning')
    const unknown = parseAlertsParams({ severity: 'all' })
    if (unknown.tab !== 'open') throw new Error('not open')
    expect(unknown.severity).toBeNull()
  })
})

describe('the history list', () => {
  it('sorts by last seen, newest first, by default', () => {
    expect(history('tab=history').list).toMatchObject({ sort: 'last_seen', dir: 'desc', per: 25 })
    expect(history('tab=history').kind).toBeNull()
  })

  it('takes a kind only in the shape SQL writes one', () => {
    expect(parseAlertKind('refund_held')).toBe('refund_held')
    expect(parseAlertKind('drift_unknown_domain')).toBe('drift_unknown_domain')
    for (const bad of ['', 'Refund', "x' or 1=1", 'a.b', 'kind:1', `a${'b'.repeat(60)}`]) {
      expect(parseAlertKind(bad), bad).toBeNull()
    }
    expect(history('tab=history&kind=email%40example.com').kind).toBeNull()
  })

  it('keeps only the open and closed states, and dates in order', () => {
    const params = history('tab=history&status=open,deleted&from=2026-10-02&to=2026-09-01')
    expect(params.list.status).toEqual(['open'])
    expect(params.list.from).toBe('2026-09-01')
    expect(params.list.to).toBe('2026-10-02')
  })

  it('links keep the tab and the kind; a new kind goes back to page 1', () => {
    const params = history('tab=history&kind=refund_held&page=3')
    expect(alertsListHref(params, { page: 4 })).toBe(
      '/admin/alerts?page=4&kind=refund_held&tab=history',
    )
    expect(historyKindHref(params, 'order_stuck')).toBe(
      '/admin/alerts?kind=order_stuck&tab=history',
    )
    // Choosing the chosen kind clears it.
    expect(historyKindHref(params, 'refund_held')).toBe('/admin/alerts?tab=history')
    expect(alertsListHref(params, { kind: null })).toBe('/admin/alerts?tab=history')
  })

  it('toggles one state chip at a time', () => {
    const none = history('tab=history')
    expect(historyStateHref(none, 'open')).toBe('/admin/alerts?status=open&tab=history')
    const open = history('tab=history&status=open&page=2')
    expect(historyStateHref(open, 'open')).toBe('/admin/alerts?tab=history')
    expect(historyStateHref(open, 'resolved')).toBe('/admin/alerts?status=resolved&tab=history')
  })

  it('sorts by how often Telegram was told', () => {
    const params = history('tab=history')
    expect(alertsSortHref(params, 'notified')).toBe('/admin/alerts?sort=notified&tab=history')
  })

  it('reads the dates as whole Lagos days, the last one included', () => {
    expect(historyWindow({ from: null, to: null })).toEqual({ seenSince: null, seenBefore: null })
    expect(historyWindow({ from: '2026-10-01', to: '2026-10-03' })).toEqual({
      seenSince: '2026-10-01T00:00:00+01:00',
      seenBefore: '2026-10-04T00:00:00+01:00',
    })
    // Month and year ends roll over.
    expect(historyWindow({ from: null, to: '2026-12-31' }).seenBefore).toBe(
      '2027-01-01T00:00:00+01:00',
    )
    expect(historyWindow({ from: null, to: '2028-02-28' }).seenBefore).toBe(
      '2028-02-29T00:00:00+01:00',
    )
  })
})

describe('the drift list', () => {
  it('sorts by last seen by default and keeps its tab in every link', () => {
    const params = parseAlertsParams({ tab: 'drift', sort: 'severity' })
    if (params.tab !== 'drift') throw new Error('not drift')
    expect(params.list).toMatchObject({ sort: 'last_seen', dir: 'desc' })
    expect(alertsListHref(params, { page: 2 })).toBe('/admin/alerts?page=2&tab=drift')
    expect(alertsSortHref(params, 'first_seen')).toBe('/admin/alerts?sort=first_seen&tab=drift')
  })
})
