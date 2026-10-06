import { describe, expect, it } from 'vitest'
import { adminHrefForAlertKey } from './alert-href'
import { isSettled, LEDGER_MATCH_LABELS, ledgerKind, normaliseTraceId } from './ledger'
import { formatUsdCents, usdToCents } from './money'
import {
  ADMIN_GATEWAY_ROUTES,
  adminNoteTarget,
  adminRouteSide,
  fillRoute,
  RENEW_CHECK_ENABLED,
} from './supplier'

describe('usdToCents', () => {
  it('reads the supplier’s dollars exactly, never through a float times 100', () => {
    expect(usdToCents(11.31)).toBe(1131)
    expect(usdToCents('11.3100')).toBe(1131)
    expect(usdToCents(0.29)).toBe(29)
    expect(usdToCents(3.69)).toBe(369)
    expect(usdToCents(15)).toBe(1500)
    expect(usdToCents('43.38')).toBe(4338)
    expect(usdToCents(0)).toBe(0)
    expect(usdToCents('.5')).toBe(50)
    expect(usdToCents('7.')).toBe(700)
  })

  it('rounds half away from zero at the cent', () => {
    expect(usdToCents('0.125')).toBe(13)
    expect(usdToCents('0.124')).toBe(12)
    expect(usdToCents('-0.125')).toBe(-13)
    expect(usdToCents(-11.31)).toBe(-1131)
    expect(usdToCents('-0.001')).toBe(0)
  })

  it('handles numbers JavaScript prints with an exponent', () => {
    expect(usdToCents(1e-7)).toBe(0)
    expect(() => usdToCents(1.5e21)).toThrow()
  })

  it('refuses anything that is not an amount', () => {
    for (const bad of ['', 'abc', '1,000.00', '$5', '1e3', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => usdToCents(bad as never)).toThrow('Not a USD amount')
    }
    expect(() => usdToCents(null as never)).toThrow('Not a USD amount')
    expect(() => usdToCents('99999999999999999999')).toThrow('out of range')
  })
})

describe('formatUsdCents', () => {
  it('formats cents as dollars, with a real minus for a debit', () => {
    expect(formatUsdCents(4338)).toBe('$43.38')
    expect(formatUsdCents(-1131)).toBe('−$11.31')
    expect(formatUsdCents(123456789)).toBe('$1,234,567.89')
    expect(formatUsdCents(5)).toBe('$0.05')
  })

  it('refuses a fraction of a cent', () => {
    expect(() => formatUsdCents(1.5)).toThrow('whole number')
  })
})

describe('ledgerKind', () => {
  const facts = { type: 5, status: 1, chargeType: 0, productType: 3 }

  it('classifies the shapes seen live', () => {
    expect(ledgerKind(facts)).toBe('topup')
    expect(ledgerKind({ type: 1, status: 1, chargeType: 1, productType: 1 })).toBe('domain_charge')
    expect(ledgerKind({ type: 1, status: 1, chargeType: 1, productType: 2 })).toBe('ssl_charge')
  })

  it('never counts an unknown shape or an unsettled entry', () => {
    expect(ledgerKind({ ...facts, type: 6 })).toBe('unclassified')
    expect(ledgerKind({ type: 1, status: 1, chargeType: 1, productType: 9 })).toBe('unclassified')
    expect(ledgerKind({ ...facts, status: 2 })).toBe('unclassified')
    expect(isSettled({ status: 1 })).toBe(true)
    expect(isSettled({ status: 0 })).toBe(false)
  })

  it('has words for every match state', () => {
    expect(Object.keys(LEDGER_MATCH_LABELS).sort()).toEqual(
      ['matched', 'pending', 'topup', 'unclassified', 'unexplained'].sort(),
    )
  })
})

describe('normaliseTraceId', () => {
  it('accepts the supplier’s GUIDs — not RFC 9562 — and lower-cases them', () => {
    expect(normaliseTraceId('38e14b09-3eb8-b811-78ce-3a2400360393')).toBe(
      '38e14b09-3eb8-b811-78ce-3a2400360393',
    )
    expect(normaliseTraceId('A476642F-9956-7CE2-9B08-3A23E027661E')).toBe(
      'a476642f-9956-7ce2-9b08-3a23e027661e',
    )
  })

  it('refuses anything else', () => {
    expect(normaliseTraceId('not-a-guid')).toBeNull()
    expect(normaliseTraceId('38e14b093eb8b81178ce3a2400360393')).toBeNull()
    expect(normaliseTraceId(42)).toBeNull()
  })
})

describe('adminHrefForAlertKey', () => {
  const id = '8dbd7ea2-c535-4a4a-a091-e202d9185a20'
  const trace = 'a476642f-9956-7ce2-9b08-3a23e027661e'

  it.each([
    [`job:${id}`, `/admin/queue/jobs/${id}`],
    [`ssl_job:${id}`, `/admin/queue/ssl-jobs/${id}`],
    [`ssl_status:${id}`, `/admin/ssl/${id}`],
    [`order_stuck:${id}`, `/admin/orders/${id}`],
    [`refund:${id}`, `/admin/refunds/${id}`],
    [`refund_overdue:${id}`, `/admin/refunds/${id}`],
    [`refund_slow:${id.toUpperCase()}`, `/admin/refunds/${id}`],
    ['incident:42', '/admin/refunds/incidents?id=42#incident-42'],
    ['drift:7', '/admin/alerts?tab=drift'],
    ['reconcile_stale:true', '/admin/alerts?tab=health'],
    ['cron_stale:email-notices', '/admin/alerts?tab=health'],
    ['cron_failed:purge-stale-carts', '/admin/alerts?tab=health'],
    ['float_low:false', '/admin/supplier'],
    ['float_cover:live', '/admin/supplier'],
    ['catalogue_sync:catalogue:production', '/admin/supplier/catalogue'],
    [`preset_hidden:${id}`, `/admin/settings/presets/${id}`],
    [`preset_failing:${id}`, `/admin/settings/presets/${id}`],
    [`preset_stale:${id}`, `/admin/settings/presets/${id}`],
    [`email_failed:${id}`, '/admin/emails?status=failed'],
    [`email_unconfirmed:${id}`, '/admin/emails?status=unconfirmed'],
    [`email_complaint:${id}`, '/admin/emails?status=complained'],
    [`notice_bounced:${id}`, '/admin/emails?tab=compliance'],
    ['emails_waiting:false', '/admin/emails?status=pending'],
    [`ledger_missing:${id}`, `/admin/orders?line=${id}`],
    [`ledger_unexplained:${trace}`, `/admin/supplier/ledger?trace=${trace}`],
    [`ledger_double:${trace}`, `/admin/supplier/ledger?trace=${trace}`],
    ['ledger_gap:live', '/admin/supplier/ledger'],
    ['admin_changed:12', '/admin/settings/admins'],
    ['admin_factor_missing:owner', '/admin/settings/admins'],
    ['admin_test_not_e2e:e2e-1a2b3c4d', '/admin/settings/admins'],
    ['admin_burst:owner', '/admin/audit?admin=owner'],
    ['admin_limit_raised:99', '/admin/audit?id=99'],
    ['admin_preset_changed:100', '/admin/audit?id=100'],
    ['something_new:1', '/admin/alerts'],
    ['nocolon', '/admin/alerts'],
  ])('%s → %s', (key, href) => {
    expect(adminHrefForAlertKey(key)).toBe(href)
  })

  it.each([
    [`mail_tenant_paused:${id}`, `https://emails.mydomainshub.com/admin/accounts/${id}`],
    [
      `mail_threshold_pause:${id.toUpperCase()}`,
      `https://emails.mydomainshub.com/admin/accounts/${id}`,
    ],
    [`mail_threshold_warning:${id}`, `https://emails.mydomainshub.com/admin/accounts/${id}`],
    ['mail_threshold_pause:../x', 'https://emails.mydomainshub.com/admin/accounts'],
    ['mail_reputation:bounce', 'https://emails.mydomainshub.com/admin/health'],
    ['mail_quota:24h', 'https://emails.mydomainshub.com/admin/health'],
    ['mail_silent:mail-worker:send', 'https://emails.mydomainshub.com/admin/health'],
    ['mail_events_silent', 'https://emails.mydomainshub.com/admin/health'],
    ['mail_tenant_action:12', 'https://emails.mydomainshub.com/admin/health'],
    ['mail_something_new:1', 'https://emails.mydomainshub.com/admin'],
  ])('a Mail alert %s opens Mail’s own admin: %s', (key, href) => {
    expect(adminHrefForAlertKey(key)).toBe(href)
  })

  it('falls back when the id is not the shape its family uses', () => {
    expect(adminHrefForAlertKey('job:../../etc')).toBe('/admin/alerts')
    expect(adminHrefForAlertKey('incident:<script>')).toBe('/admin/refunds/incidents')
    expect(adminHrefForAlertKey('ledger_missing:nope')).toBe('/admin/orders')
    expect(adminHrefForAlertKey('admin_burst:Not A Label')).toBe('/admin/audit')
    expect(adminHrefForAlertKey('admin_limit_raised:x')).toBe('/admin/audit')
  })
})

describe('the admin gateway routes', () => {
  it('fills a template, encoding each parameter', () => {
    expect(fillRoute('admin/supplier/domains/:name', { name: 'example.com' })).toBe(
      'admin/supplier/domains/example.com',
    )
    expect(fillRoute('admin/supplier/ssl/:name', { name: '*.example.com' })).toBe(
      'admin/supplier/ssl/*.example.com',
    )
    expect(fillRoute('admin/x/:name', { name: 'a/b?c' })).toBe('admin/x/a%2Fb%3Fc')
    expect(fillRoute('admin/supplier/balance')).toBe('admin/supplier/balance')
    expect(() => fillRoute('admin/supplier/domains/:name', {})).toThrow(
      'Missing route parameter name',
    )
  })

  it('claims the action each route is for', () => {
    expect(ADMIN_GATEWAY_ROUTES.balance.action).toBe('supplier.balance')
    expect(ADMIN_GATEWAY_ROUTES.catalogueApply.method).toBe('POST')
    expect(ADMIN_GATEWAY_ROUTES.flwRefundCheck.action).toBe('refund.flw_check')
    for (const route of Object.values(ADMIN_GATEWAY_ROUTES)) {
      expect(route.template.startsWith('admin/')).toBe(true)
    }
    expect(RENEW_CHECK_ENABLED).toBe(true)
  })

  it('notes storefront reads on the global side, the rest on theirs', () => {
    expect(adminRouteSide('priceCheck', 'live')).toBe('global')
    expect(adminRouteSide('catalogueApply', 'test')).toBe('global')
    expect(adminRouteSide('presetDraftCheck', 'live')).toBe('global')
    expect(adminRouteSide('balance', 'test')).toBe('test')
    expect(adminRouteSide('flwRefundCheck', 'live')).toBe('live')
  })

  it('names the target the gateway will claim', () => {
    expect(adminNoteTarget('balance', { side: 'test' })).toBe('test')
    expect(adminNoteTarget('ledger', { side: 'live' })).toBe('live')
    expect(adminNoteTarget('domainLookup', { side: 'live', name: 'example.com' })).toBe(
      'example.com',
    )
    expect(adminNoteTarget('sslLookup', { side: 'live', name: '*.example.com' })).toBe(
      '*.example.com',
    )
    expect(adminNoteTarget('priceCheck', { side: 'global', tld: 'com' })).toBe('com')
    expect(adminNoteTarget('flwRefundCheck', { side: 'test', flwRefundId: '123' })).toBe('123')
    expect(adminNoteTarget('presetDraftCheck', { side: 'global', id: 'abc' })).toBe('abc')
    expect(adminNoteTarget('cataloguePreview', { side: 'global' })).toBe('tlds')
    expect(adminNoteTarget('catalogueApply', { side: 'global' })).toBe('tlds')
    expect(adminNoteTarget('sslCataloguePreview', { side: 'global' })).toBe('ssl')
    expect(adminNoteTarget('sslCatalogueApply', { side: 'global' })).toBe('ssl')
    expect(() => adminNoteTarget('domainLookup', { side: 'live' })).toThrow('A name is required')
    expect(() => adminNoteTarget('priceCheck', { side: 'global' })).toThrow('An extension')
    expect(() => adminNoteTarget('flwRefundCheck', { side: 'live' })).toThrow('A refund id')
    expect(() => adminNoteTarget('presetDraftCheck', { side: 'global' })).toThrow('A draft id')
  })
})
