import { describe, expect, it } from 'vitest'
import { ADMIN_TIERS } from '@/features/admin/lib/actions'
import {
  AUDIT_PATH,
  AUDIT_PREFIXES,
  auditFiltersActive,
  auditHref,
  parseAuditId,
  parseAuditLabel,
  parseAuditParams,
  parseAuditTarget,
  toggleOutcome,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/audit-params'
import { adminHref } from '@/features/admin/lib/href'

const UUID = '7A7B7C7D-8E8F-4A9B-8CAD-BEBFC0C1D2D3'

describe('parseAuditParams', () => {
  it('opens on every entry, newest first, fifty to a page', () => {
    const params = parseAuditParams({})
    expect(params).toEqual({
      list: { sort: 'when', dir: 'desc', page: 1, per: 50, status: [], from: null, to: null },
      prefix: null,
      outcome: [],
      side: null,
      who: null,
      admin: null,
      target: null,
      id: null,
    })
    expect(auditFiltersActive(params)).toBe(false)
    expect(auditHref(params)).toBe(AUDIT_PATH)
  })

  it('reads every filter the URL can carry', () => {
    const params = parseAuditParams({
      action: 'supplier',
      outcome: 'refused,intent',
      side: 'test',
      who: 'test',
      admin: 'E2E-1a2b3c4d',
      target: UUID,
      id: '42',
      from: '2026-10-01',
      to: '2026-10-03',
      dir: 'asc',
      per: '100',
      page: '3',
    })
    expect(params).toMatchObject({
      prefix: 'supplier',
      // In the chips' order, whatever order the URL had them in.
      outcome: ['intent', 'refused'],
      side: 'test',
      who: 'test',
      admin: 'e2e-1a2b3c4d',
      target: UUID.toLowerCase(),
      id: 42,
      list: { from: '2026-10-01', to: '2026-10-03', dir: 'asc', per: 100, page: 3 },
    })
    expect(auditFiltersActive(params)).toBe(true)
  })

  it('takes the same filters from URLSearchParams', () => {
    const params = parseAuditParams(new URLSearchParams('action=refund&outcome=ok&id=7'))
    expect(params).toMatchObject({ prefix: 'refund', outcome: ['ok'], id: 7 })
  })

  it('drops anything unknown or misshapen rather than querying with it', () => {
    const params = parseAuditParams({
      action: 'refund.approve',
      outcome: 'maybe,,ok',
      side: 'both',
      who: 'everyone',
      admin: 'someone@example.com',
      target: 'example.com',
      id: '0',
      from: '2026-02-30',
      per: '7',
    })
    expect(params).toMatchObject({
      prefix: null,
      outcome: ['ok'],
      side: null,
      who: null,
      admin: null,
      target: null,
      id: null,
      list: { from: null, per: 50 },
    })
  })

  it('takes the first of a repeated parameter', () => {
    expect(parseAuditParams({ action: ['job', 'refund'] }).prefix).toBe('job')
  })

  it('never splits a test administrator by who acted: they see test administrators only', () => {
    expect(parseAuditParams({ who: 'admins' }, true).who).toBeNull()
    expect(parseAuditParams({ who: 'admins' }, false).who).toBe('admins')
  })
})

describe('the parsers', () => {
  it('takes an admin label, never an email or a name with spaces', () => {
    expect(parseAuditLabel(' Owner ')).toBe('owner')
    expect(parseAuditLabel('e2e-1a2b_3c')).toBe('e2e-1a2b_3c')
    expect(parseAuditLabel('a@b.co')).toBeNull()
    expect(parseAuditLabel('x')).toBeNull()
    expect(parseAuditLabel('two words')).toBeNull()
    expect(parseAuditLabel(undefined)).toBeNull()
  })

  it('takes a target by id only: a uuid or a number, never a domain', () => {
    expect(parseAuditTarget(UUID)).toBe(UUID.toLowerCase())
    expect(parseAuditTarget('123456')).toBe('123456')
    expect(parseAuditTarget('shop.example.com')).toBeNull()
    expect(parseAuditTarget('0')).toBeNull()
    expect(parseAuditTarget('')).toBeNull()
  })

  it('takes an entry number JavaScript holds exactly', () => {
    expect(parseAuditId('1')).toBe(1)
    expect(parseAuditId('999999999999999')).toBe(999_999_999_999_999)
    expect(parseAuditId('9999999999999999')).toBeNull()
    expect(parseAuditId('-3')).toBeNull()
    expect(parseAuditId('1.5')).toBeNull()
  })

  it('reads the entry links other pages build', () => {
    const href = adminHref.audit(42)
    const params = parseAuditParams(new URLSearchParams(href.split('?')[1]))
    expect(params.id).toBe(42)
    expect(auditHref(params)).toBe(href)
  })
})

describe('auditHref', () => {
  const params = parseAuditParams({
    action: 'job',
    outcome: 'refused',
    admin: 'owner',
    from: '2026-10-01',
    page: '4',
    per: '25',
  })

  it('keeps every filter, the defaults left out, in one order', () => {
    expect(auditHref(params)).toBe(
      '/admin/audit?action=job&outcome=refused&admin=owner&from=2026-10-01&per=25&page=4',
    )
  })

  it('goes back to page 1 when a filter changes, and keeps the page when only it changes', () => {
    expect(auditHref(params, { prefix: 'refund' })).toBe(
      '/admin/audit?action=refund&outcome=refused&admin=owner&from=2026-10-01&per=25',
    )
    expect(auditHref(params, { page: 5 })).toContain('page=5')
    expect(auditHref(params, { dir: 'asc' })).toBe(
      '/admin/audit?action=job&outcome=refused&admin=owner&from=2026-10-01&dir=asc&per=25',
    )
  })

  it('clears what is asked: the admin and the days together', () => {
    expect(auditHref(params, { admin: null, from: null, to: null })).toBe(
      '/admin/audit?action=job&outcome=refused&per=25',
    )
  })

  it('writes the side, who, target and entry when they are set', () => {
    const narrowed = parseAuditParams({ side: 'live', who: 'admins', target: '12', id: '9' })
    expect(auditHref(narrowed)).toBe('/admin/audit?side=live&who=admins&target=12&id=9')
  })

  it('toggles one outcome chip at a time, in the chips’ order', () => {
    expect(toggleOutcome(params, 'intent')).toContain('outcome=intent%2Crefused')
    expect(toggleOutcome(params, 'refused')).not.toContain('outcome=')
  })
})

describe('Lagos days', () => {
  it('starts a day at midnight WAT and ends it at the next midnight', () => {
    expect(watDayStart('2026-10-03')).toBe('2026-10-03T00:00:00+01:00')
    expect(watDayEnd('2026-10-03')).toBe('2026-10-04T00:00:00+01:00')
    expect(watDayEnd('2026-12-31')).toBe('2027-01-01T00:00:00+01:00')
  })
})

describe('the action chips', () => {
  it('offer every family admin_tier knows, and nothing else', () => {
    const families = new Set(Object.keys(ADMIN_TIERS).map((action) => action.split('.')[0]))
    expect(new Set(AUDIT_PREFIXES)).toEqual(families)
  })
})
