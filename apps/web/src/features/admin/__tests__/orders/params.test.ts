import { describe, expect, it } from 'vitest'
import {
  classifyOrderSearch,
  funnelRange,
  isFiltered,
  nextDay,
  ORDER_LIST_SPEC,
  ORDER_SORT_COLUMN,
  ordersHref,
  parseOrderListParams,
  toggleStatus,
  watDayStart,
  watToday,
} from '@/features/admin/lib/orders-params'

const LINE = '8f2b9c4e-1a3d-4e5f-9a7b-6c5d4e3f2a1b'

describe('the orders search box', () => {
  it('takes an order number as SQL writes it, padded and upper-cased', () => {
    expect(classifyOrderSearch('ND-001035')).toEqual({ kind: 'order_number', value: 'ND-001035' })
    expect(classifyOrderSearch(' nd-1035 ')).toEqual({ kind: 'order_number', value: 'ND-001035' })
  })

  it('takes a payment reference with its uuid lower-cased', () => {
    expect(classifyOrderSearch('MDH-4FB8AFE8-1A3D-4E5F-9A7B-6C5D4E3F2A1B')).toEqual({
      kind: 'tx_ref',
      value: 'MDH-4fb8afe8-1a3d-4e5f-9a7b-6c5d4e3f2a1b',
    })
  })

  it('takes live and test invoice numbers', () => {
    expect(classifyOrderSearch('inv-2')).toEqual({ kind: 'invoice', value: 'INV-000002' })
    expect(classifyOrderSearch('TEST-INV-000001')).toEqual({
      kind: 'invoice',
      value: 'TEST-INV-000001',
    })
  })

  it('takes a domain in its ASCII form, lower-cased, a trailing dot dropped', () => {
    expect(classifyOrderSearch('GetPaid.com.')).toEqual({ kind: 'domain', value: 'getpaid.com' })
    expect(classifyOrderSearch('café.ng')).toEqual({ kind: 'domain', value: 'xn--caf-dma.ng' })
  })

  it('never takes an email, however it is written', () => {
    for (const email of ['ada@example.com', ' x@y ', '@', 'ND-001035@example.com']) {
      expect(classifyOrderSearch(email)).toEqual({ kind: 'email' })
    }
  })

  it('refuses anything else rather than guessing', () => {
    for (const text of ['hello', '12345', 'ND-', 'MDH-123', 'a'.repeat(121), 'drop table;']) {
      expect(classifyOrderSearch(text)).toEqual({ kind: 'unknown' })
    }
    expect(classifyOrderSearch('   ')).toEqual({ kind: 'none' })
    expect(classifyOrderSearch(undefined)).toEqual({ kind: 'none' })
  })
})

describe('the orders list params', () => {
  it('defaults to newest first, 25 a page, everything shown', () => {
    const params = parseOrderListParams({})
    expect(params).toMatchObject({
      sort: 'placed',
      dir: 'desc',
      page: 1,
      per: 25,
      status: [],
      from: null,
      to: null,
      kind: null,
      stuck: false,
      line: null,
      q: '',
      search: { kind: 'none' },
    })
    expect(ORDER_SORT_COLUMN[params.sort]).toBe('created_at')
    expect(isFiltered(params)).toBe(false)
  })

  it('reads every filter it knows, and drops what it does not', () => {
    const params = parseOrderListParams(
      new URLSearchParams(
        `status=paid,completed,bogus&kind=transfer&stuck=1&line=${LINE.toUpperCase()}&sort=total&dir=asc&page=3&per=50&from=2026-09-30&to=2026-09-01&q=ND-1035`,
      ),
    )
    expect(params).toMatchObject({
      status: ['paid', 'completed'],
      kind: 'transfer',
      stuck: true,
      line: LINE,
      sort: 'total',
      dir: 'asc',
      page: 3,
      per: 50,
      // Dates in the wrong order are swapped, not refused.
      from: '2026-09-01',
      to: '2026-09-30',
      q: 'ND-1035',
      search: { kind: 'order_number', value: 'ND-001035' },
    })
    expect(isFiltered(params)).toBe(true)
  })

  it('falls back on an unknown kind, sort, line or page size', () => {
    const params = parseOrderListParams({
      kind: 'refund',
      sort: 'email',
      line: 'not-a-uuid',
      per: '7',
      stuck: 'yes',
      page: '-2',
    })
    expect(params).toMatchObject({
      kind: null,
      sort: 'placed',
      line: null,
      per: 25,
      stuck: false,
      page: 1,
    })
  })

  it('keeps an email out of the box and out of every link', () => {
    const params = parseOrderListParams({ q: 'ada@example.com', status: 'paid' })
    expect(params.search).toEqual({ kind: 'email' })
    expect(params.q).toBe('')
    for (const href of [
      ordersHref(params),
      ordersHref(params, { page: 2 }),
      ordersHref(params, { sort: 'total', dir: 'desc' }),
      ordersHref(params, { status: [] }),
    ]) {
      expect(href).not.toContain('@')
      expect(href).not.toContain('%40')
    }
  })

  it('builds links from the parsed values, back to page 1 when a filter changes', () => {
    const params = parseOrderListParams({
      status: 'paid',
      kind: 'renew',
      page: '4',
      q: 'getpaid.com',
    })
    expect(ordersHref(params)).toBe('/admin/orders?status=paid&page=4&kind=renew&q=getpaid.com')
    expect(ordersHref(params, { page: 5 })).toBe(
      '/admin/orders?status=paid&page=5&kind=renew&q=getpaid.com',
    )
    expect(ordersHref(params, { kind: null })).toBe('/admin/orders?status=paid&q=getpaid.com')
    expect(ordersHref(params, { stuck: true })).toBe(
      '/admin/orders?status=paid&kind=renew&stuck=1&q=getpaid.com',
    )
    expect(ordersHref(params, { q: '' })).toBe('/admin/orders?status=paid&kind=renew')
    expect(ordersHref(params, { status: toggleStatus(params, 'paid') })).toBe(
      '/admin/orders?kind=renew&q=getpaid.com',
    )
    expect(ordersHref(params, { line: LINE })).toBe(
      `/admin/orders?status=paid&kind=renew&line=${LINE}&q=getpaid.com`,
    )
  })

  it('toggles a status chip on and off', () => {
    const params = parseOrderListParams({ status: 'paid' })
    expect(toggleStatus(params, 'failed')).toEqual(['paid', 'failed'])
    expect(toggleStatus(params, 'paid')).toEqual([])
    expect(ORDER_LIST_SPEC.statuses).toContain('partially_failed')
  })
})

describe('days in Lagos', () => {
  it('starts a day at Lagos midnight, an hour before UTC', () => {
    expect(watDayStart('2026-10-03')).toBe('2026-10-03T00:00:00+01:00')
    expect(new Date(watDayStart('2026-10-03')).toISOString()).toBe('2026-10-02T23:00:00.000Z')
  })

  it('steps over month and year ends', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })

  it('is already tomorrow in Lagos at 23:30 UTC', () => {
    expect(watToday(new Date('2026-10-02T23:30:00Z'))).toBe('2026-10-03')
    expect(watToday(new Date('2026-10-02T22:30:00Z'))).toBe('2026-10-02')
  })

  it('gives the funnel the list dates, or the 30 days to today', () => {
    const now = new Date('2026-10-03T12:00:00Z')
    expect(funnelRange({ from: null, to: null }, now)).toEqual({
      from: '2026-09-04',
      to: '2026-10-03',
    })
    expect(funnelRange({ from: '2026-09-01', to: '2026-09-10' }, now)).toEqual({
      from: '2026-09-01',
      to: '2026-09-10',
    })
    expect(funnelRange({ from: '2026-09-20', to: null }, now)).toEqual({
      from: '2026-09-20',
      to: '2026-10-03',
    })
    expect(funnelRange({ from: null, to: '2026-09-10' }, now)).toEqual({
      from: '2026-08-12',
      to: '2026-09-10',
    })
    // A start after today runs to that day, never backwards.
    expect(funnelRange({ from: '2026-10-09', to: null }, now)).toEqual({
      from: '2026-10-09',
      to: '2026-10-09',
    })
  })
})
