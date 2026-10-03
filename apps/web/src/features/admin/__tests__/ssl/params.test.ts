import { describe, expect, it } from 'vitest'
import {
  classifySslSearch,
  isSslFiltered,
  parseCertificateId,
  parseSslListParams,
  SSL_LIST_SPEC,
  SSL_SORT_COLUMN,
  sslHref,
  toggleSslStatus,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/ssl-params'

const CERT = '0C1E2F3A-4B5C-4D6E-8F70-81A2B3C4D5E6'

describe('classifySslSearch', () => {
  it('finds a bare name and the wildcard over it, exactly', () => {
    expect(classifySslSearch(' Shop.Example.com. ')).toEqual({
      kind: 'name',
      value: 'shop.example.com',
      names: ['shop.example.com', '*.shop.example.com'],
    })
  })

  it('finds a wildcard by its own name only', () => {
    expect(classifySslSearch('*.example.com')).toEqual({
      kind: 'name',
      value: '*.example.com',
      names: ['*.example.com'],
    })
  })

  it('looks up an international name in its ASCII form (FR-S8)', () => {
    expect(classifySslSearch('café.com')).toMatchObject({ kind: 'name', value: 'xn--caf-dma.com' })
  })

  it('refuses an email before anything is searched (N13)', () => {
    expect(classifySslSearch('someone@example.com')).toEqual({ kind: 'email' })
  })

  it('says nothing was searched for what is not a name', () => {
    expect(classifySslSearch('')).toEqual({ kind: 'none' })
    expect(classifySslSearch('   ')).toEqual({ kind: 'none' })
    expect(classifySslSearch('ND-001035')).toEqual({ kind: 'unknown' })
    expect(classifySslSearch('localhost')).toEqual({ kind: 'unknown' })
    expect(classifySslSearch(`${'a'.repeat(118)}.com`)).toEqual({ kind: 'unknown' })
    expect(classifySslSearch('*.')).toEqual({ kind: 'unknown' })
  })
})

describe('parseSslListParams', () => {
  it('reads the shared list params and the certificate filters', () => {
    const params = parseSslListParams({
      status: 'issued,awaiting_setup,nonsense',
      from: '2026-10-03',
      to: '2026-10-01',
      sort: 'expires',
      dir: 'asc',
      page: '3',
      per: '50',
      unrecognised: '1',
      line: CERT,
      q: 'shop.example.com',
    })
    expect(params).toMatchObject({
      status: ['issued', 'awaiting_setup'],
      // Swapped into order.
      from: '2026-10-01',
      to: '2026-10-03',
      sort: 'expires',
      dir: 'asc',
      page: 3,
      per: 50,
      unrecognised: true,
      line: CERT.toLowerCase(),
      q: 'shop.example.com',
      search: { kind: 'name', value: 'shop.example.com' },
    })
  })

  it('falls back to the defaults for anything it does not know', () => {
    const params = parseSslListParams({
      sort: 'price',
      dir: 'up',
      page: 'two',
      per: '7',
      unrecognised: 'yes',
      line: 'not-a-uuid',
    })
    expect(params).toMatchObject({
      sort: 'ordered',
      dir: 'desc',
      page: 1,
      per: 25,
      status: [],
      unrecognised: false,
      line: null,
      q: '',
      search: { kind: 'none' },
    })
    expect(isSslFiltered(params)).toBe(false)
  })

  it('keeps no email, even in the box', () => {
    const params = parseSslListParams(new URLSearchParams('q=someone%40example.com'))
    expect(params.search).toEqual({ kind: 'email' })
    expect(params.q).toBe('')
    expect(sslHref(params)).toBe('/admin/ssl')
  })

  it('reads each filter as a filter', () => {
    for (const search of [
      { status: 'failed' },
      { from: '2026-10-01' },
      { to: '2026-10-01' },
      { unrecognised: '1' },
      { line: CERT },
      { q: 'example.com' },
      { q: 'not a name' },
    ]) {
      expect(isSslFiltered(parseSslListParams(search)), JSON.stringify(search)).toBe(true)
    }
  })

  it('sorts by the column each sort names', () => {
    expect(SSL_LIST_SPEC.defaultSort).toBe('ordered')
    expect(SSL_SORT_COLUMN).toEqual({
      ordered: 'created_at',
      expires: 'expires_at',
      checked: 'last_checked_at',
    })
  })
})

describe('sslHref', () => {
  const params = parseSslListParams({
    status: 'issued',
    page: '2',
    unrecognised: '1',
    q: 'example.com',
  })

  it('keeps the list, leaving defaults out', () => {
    expect(sslHref(params)).toBe('/admin/ssl?status=issued&page=2&unrecognised=1&q=example.com')
  })

  it('goes back to page 1 when a filter changes', () => {
    expect(sslHref(params, { unrecognised: false })).toBe('/admin/ssl?status=issued&q=example.com')
    expect(sslHref(params, { q: '' })).toBe('/admin/ssl?status=issued&unrecognised=1')
    expect(sslHref(params, { line: CERT.toLowerCase() })).toBe(
      `/admin/ssl?status=issued&unrecognised=1&line=${CERT.toLowerCase()}&q=example.com`,
    )
    expect(sslHref(params, { status: [] })).toBe('/admin/ssl?unrecognised=1&q=example.com')
  })

  it('pages and sorts', () => {
    expect(sslHref(params, { page: 3 })).toBe(
      '/admin/ssl?status=issued&page=3&unrecognised=1&q=example.com',
    )
    expect(sslHref(params, { sort: 'expires', dir: 'asc' })).toBe(
      '/admin/ssl?status=issued&sort=expires&dir=asc&unrecognised=1&q=example.com',
    )
  })

  it('toggles one status chip', () => {
    expect(toggleSslStatus(params, 'failed')).toEqual(['issued', 'failed'])
    expect(toggleSslStatus(params, 'issued')).toEqual([])
  })
})

describe('dates and ids', () => {
  it('bounds a WAT day, across a month end', () => {
    expect(watDayStart('2026-10-03')).toBe('2026-10-03T00:00:00+01:00')
    expect(watDayEnd('2026-10-31')).toBe('2026-11-01T00:00:00+01:00')
  })

  it('reads only a uuid as a certificate id', () => {
    expect(parseCertificateId(CERT)).toBe(CERT.toLowerCase())
    expect(parseCertificateId('example.com')).toBeNull()
    expect(parseCertificateId('')).toBeNull()
    expect(parseCertificateId(undefined)).toBeNull()
  })
})
