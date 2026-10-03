import { describe, expect, it } from 'vitest'
import {
  classifyDomainSearch,
  DOMAIN_LIST_SPEC,
  DOMAIN_SORT_COLUMN,
  DOMAIN_STATUSES,
  domainsHref,
  expiryRange,
  filteredHref,
  isFiltered,
  LIVE_STATUSES,
  parseDomainId,
  parseDomainListParams,
  parseTld,
  toggleStatus,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/domains-params'

describe('the domains list URL (ADMIN-SPEC §5.2 B9)', () => {
  it('defaults to every domain but demo rows, soonest expiry first, 25 a page', () => {
    const params = parseDomainListParams({})
    expect(params).toMatchObject({
      sort: 'expires',
      dir: 'asc',
      page: 1,
      per: 25,
      status: [],
      from: null,
      to: null,
      tld: null,
      expires: null,
      delegation: null,
      renew: null,
      source: null,
      q: '',
      search: { kind: 'none' },
    })
    expect(isFiltered(params)).toBe(false)
  })

  it('reads every filter it knows, and drops what it does not', () => {
    const params = parseDomainListParams({
      status: 'active,redemption,nonsense',
      tld: '.COM.ng',
      expires: '30',
      delegation: 'failed',
      renew: 'off',
      source: 'transfer',
      sort: 'name',
      dir: 'desc',
      page: '3',
      per: '50',
      from: '2026-10-05',
      to: '2026-09-01',
    })
    expect(params.status).toEqual(['active', 'redemption'])
    expect(params.tld).toBe('com.ng')
    expect(params.expires).toBe('30')
    expect(params.delegation).toBe('failed')
    expect(params.renew).toBe('off')
    expect(params.source).toBe('transfer')
    expect(params.sort).toBe('name')
    expect(params.dir).toBe('desc')
    expect(params.page).toBe(3)
    expect(params.per).toBe(50)
    // Dates out of order are put in order.
    expect([params.from, params.to]).toEqual(['2026-09-01', '2026-10-05'])
    expect(isFiltered(params)).toBe(true)

    const junk = parseDomainListParams({
      tld: 'c_m',
      expires: '45',
      delegation: 'maybe',
      renew: 'yes',
      source: 'stolen',
      sort: 'registrant',
    })
    expect(junk).toMatchObject({
      tld: null,
      expires: null,
      delegation: null,
      renew: null,
      source: null,
      sort: 'expires',
    })
  })

  it('reads the same values from URLSearchParams and from repeated keys', () => {
    expect(parseDomainListParams(new URLSearchParams('expires=expired&q=getpaid')).expires).toBe(
      'expired',
    )
    expect(parseDomainListParams({ expires: ['60', '90'] }).expires).toBe('60')
  })

  it('knows every domain status, and the live ones the stats count', () => {
    expect(DOMAIN_STATUSES).toHaveLength(14)
    expect(DOMAIN_LIST_SPEC.statuses).toBe(DOMAIN_STATUSES)
    expect(LIVE_STATUSES).toEqual(['active', 'expired_grace', 'redemption'])
    expect(DOMAIN_SORT_COLUMN).toEqual({
      expires: 'expires_at',
      added: 'created_at',
      name: 'domain_name',
      checked: 'registry_checked_at',
    })
  })
})

describe('the search box: a domain or part of one, never an email (N13)', () => {
  it('takes a domain, part of one, or an extension, lower-cased', () => {
    expect(classifyDomainSearch('GetPaid.com')).toEqual({ kind: 'name', value: 'getpaid.com' })
    expect(classifyDomainSearch('getpaid')).toEqual({ kind: 'name', value: 'getpaid' })
    expect(classifyDomainSearch('.com.ng')).toEqual({ kind: 'name', value: '.com.ng' })
    expect(classifyDomainSearch('getpaid.com.')).toEqual({ kind: 'name', value: 'getpaid.com' })
  })

  it('searches an international name by its ASCII form (FR-S8)', () => {
    expect(classifyDomainSearch('café.com')).toEqual({ kind: 'name', value: 'xn--caf-dma.com' })
  })

  it('refuses an email, and keeps it out of the box and every link', () => {
    const params = parseDomainListParams({ q: 'ada@example.com', status: 'active' })
    expect(params.search).toEqual({ kind: 'email' })
    expect(params.q).toBe('')
    expect(domainsHref(params, { page: 2 })).not.toContain('example.com')
    expect(domainsHref(params, { page: 2 })).not.toContain('%40')
  })

  it('calls anything else unknown: LIKE syntax, spaces, one letter or too long', () => {
    for (const text of ['get%paid', 'get paid', 'g', 'a_b', 'x'.repeat(121)]) {
      expect(classifyDomainSearch(text), text).toEqual({ kind: 'unknown' })
    }
    expect(classifyDomainSearch('   ')).toEqual({ kind: 'none' })
    expect(classifyDomainSearch(undefined)).toEqual({ kind: 'none' })
  })
})

describe('links to the list', () => {
  it('keeps every filter, leaves defaults out, and goes back to page 1 when one changes', () => {
    const params = parseDomainListParams({
      status: 'active',
      tld: 'com',
      expires: '30',
      delegation: 'pending',
      renew: 'on',
      source: 'demo',
      q: 'getpaid',
      page: '4',
    })
    expect(domainsHref(params)).toBe(
      '/admin/domains?status=active&page=4&tld=com&expires=30&delegation=pending&renew=on&source=demo&q=getpaid',
    )
    expect(domainsHref(params, { tld: null })).toBe(
      '/admin/domains?status=active&expires=30&delegation=pending&renew=on&source=demo&q=getpaid',
    )
    expect(domainsHref(params, { page: 5 })).toContain('page=5')
    expect(domainsHref(params, { sort: 'name', dir: 'desc' })).not.toContain('page=')
    expect(domainsHref(parseDomainListParams({}))).toBe('/admin/domains')
  })

  it('builds a tile’s link from nothing', () => {
    expect(filteredHref({ status: ['active', 'expired_grace', 'redemption'], expires: '30' })).toBe(
      '/admin/domains?status=active%2Cexpired_grace%2Credemption&expires=30',
    )
    expect(filteredHref({ tld: 'ng' })).toBe('/admin/domains?tld=ng')
  })

  it('toggles a status chip on and off', () => {
    const params = parseDomainListParams({ status: 'active' })
    expect(toggleStatus(params, 'redemption')).toEqual(['active', 'redemption'])
    expect(toggleStatus(params, 'active')).toEqual([])
  })
})

describe('dates and ids', () => {
  const now = new Date('2026-10-03T12:00:00Z')

  it('turns an expiry window into instants, as admin_domain_stats counts them', () => {
    expect(expiryRange('expired', now)).toEqual({ before: '2026-10-03T12:00:00.000Z' })
    expect(expiryRange('30', now)).toEqual({
      from: '2026-10-03T12:00:00.000Z',
      to: '2026-11-02T12:00:00.000Z',
    })
    expect(expiryRange('90', now).to).toBe('2027-01-01T12:00:00.000Z')
  })

  it('bounds a WAT day: Lagos is UTC+1 all year', () => {
    expect(watDayStart('2026-10-03')).toBe('2026-10-03T00:00:00+01:00')
    expect(watDayEnd('2026-12-31')).toBe('2027-01-01T00:00:00+01:00')
  })

  it('reads an extension and a domain id strictly', () => {
    expect(parseTld('NG')).toBe('ng')
    expect(parseTld('')).toBeNull()
    expect(parseTld('com ng')).toBeNull()
    expect(parseDomainId('5A5B5C5D-6E6F-4A7B-8C8D-9E9FA0A1B2B3')).toBe(
      '5a5b5c5d-6e6f-4a7b-8c8d-9e9fa0a1b2b3',
    )
    expect(parseDomainId(['5a5b5c5d-6e6f-4a7b-8c8d-9e9fa0a1b2b3'])).toBe(
      '5a5b5c5d-6e6f-4a7b-8c8d-9e9fa0a1b2b3',
    )
    expect(parseDomainId('example.com')).toBeNull()
    expect(parseDomainId(undefined)).toBeNull()
  })
})
