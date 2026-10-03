import { describe, expect, it } from 'vitest'
import { parseListParams } from '@/features/admin/lib/list-params'
import {
  addDays,
  DOMAIN_JOB_KINDS,
  failRefundKobo,
  filtersActive,
  hasOpenJob,
  JOB_LIST_SPEC,
  jobsHref,
  type LineRefund,
  lineRefundKobo,
  linesWithoutJob,
  openLineRefund,
  parseKind,
  parseUuid,
  READ_WINDOW_MS,
  readVerdict,
  refundAtProvider,
  SSL_JOB_KINDS,
  tabRedirect,
  watDate,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/queue-facts'

const ID = '5f0e0d0c-0b0a-4908-8706-050403020100'

describe('the queue lists in the URL', () => {
  it('reads status, sort, page and dates strictly, newest first by default', () => {
    expect(parseListParams({}, JOB_LIST_SPEC)).toEqual({
      sort: 'created',
      dir: 'desc',
      page: 1,
      per: 25,
      status: [],
      from: null,
      to: null,
    })
    const params = parseListParams(
      {
        status: 'needs_attention,failed,bogus',
        sort: 'attempts',
        dir: 'asc',
        page: '3',
        per: '50',
        from: '2026-10-03',
        to: '2026-09-01',
      },
      JOB_LIST_SPEC,
    )
    expect(params).toEqual({
      sort: 'attempts',
      dir: 'asc',
      page: 3,
      per: 50,
      status: ['needs_attention', 'failed'],
      from: '2026-09-01',
      to: '2026-10-03',
    })
    expect(parseListParams({ sort: 'domain_name' }, JOB_LIST_SPEC).sort).toBe('created')
  })

  it('takes a kind only from its own list', () => {
    expect(parseKind({ kind: 'renew_domain' }, DOMAIN_JOB_KINDS)).toBe('renew_domain')
    expect(parseKind({ kind: ['set_privacy', 'x'] }, DOMAIN_JOB_KINDS)).toBe('set_privacy')
    expect(parseKind({ kind: 'ssl_initialize' }, DOMAIN_JOB_KINDS)).toBeNull()
    expect(parseKind({ kind: 'ssl_initialize' }, SSL_JOB_KINDS)).toBe('ssl_initialize')
    expect(parseKind({}, DOMAIN_JOB_KINDS)).toBeNull()
  })

  it('takes ids only in their shape, lower-cased', () => {
    expect(parseUuid(ID.toUpperCase())).toBe(ID)
    expect(parseUuid([ID])).toBe(ID)
    expect(parseUuid('example.com')).toBeNull()
    expect(parseUuid(undefined)).toBeNull()
    expect(parseUuid(null)).toBeNull()
  })

  it('sends an old `?tab=` link to its page', () => {
    expect(tabRedirect({ tab: 'pending' })).toBe('/admin/queue/pending')
    expect(tabRedirect({ tab: 'ssl' })).toBe('/admin/queue/ssl-jobs')
    expect(tabRedirect({ tab: ['ssl-jobs'] })).toBe('/admin/queue/ssl-jobs')
    expect(tabRedirect({ tab: 'jobs' })).toBeNull()
    expect(tabRedirect({})).toBeNull()
  })

  it('builds links that keep the kind and domain filters, back to page 1 on a new filter', () => {
    const params = parseListParams({ status: 'failed', page: '2' }, JOB_LIST_SPEC)
    const filters = { kind: 'register_domain', domainId: ID }
    expect(jobsHref('/admin/queue', params, filters)).toBe(
      `/admin/queue?status=failed&page=2&kind=register_domain&domain=${ID}`,
    )
    expect(jobsHref('/admin/queue', params, filters, { page: 3 })).toBe(
      `/admin/queue?status=failed&page=3&kind=register_domain&domain=${ID}`,
    )
    expect(jobsHref('/admin/queue', params, filters, { kind: null })).toBe(
      `/admin/queue?status=failed&domain=${ID}`,
    )
    expect(jobsHref('/admin/queue', params, filters, { kind: 'set_privacy' })).toBe(
      `/admin/queue?status=failed&kind=set_privacy&domain=${ID}`,
    )
    expect(jobsHref('/admin/queue', params, { kind: null, domainId: null }, { status: [] })).toBe(
      '/admin/queue',
    )
  })

  it('knows when any filter is on', () => {
    const none = parseListParams({}, JOB_LIST_SPEC)
    expect(filtersActive(none, { kind: null, domainId: null })).toBe(false)
    expect(filtersActive(none, { kind: 'set_privacy', domainId: null })).toBe(true)
    expect(filtersActive(none, { kind: null, domainId: ID })).toBe(true)
    expect(
      filtersActive(parseListParams({ from: '2026-10-01' }, JOB_LIST_SPEC), {
        kind: null,
        domainId: null,
      }),
    ).toBe(true)
    expect(
      filtersActive(parseListParams({ status: 'queued' }, JOB_LIST_SPEC), {
        kind: null,
        domainId: null,
      }),
    ).toBe(true)
  })

  it('refreshes only while a shown job is with the worker', () => {
    expect(hasOpenJob([{ status: 'failed' }, { status: 'running' }])).toBe(true)
    expect(hasOpenJob([{ status: 'queued' }])).toBe(true)
    expect(hasOpenJob([{ status: 'succeeded' }, { status: 'needs_attention' }])).toBe(false)
    expect(hasOpenJob([])).toBe(false)
  })
})

describe('Lagos days', () => {
  it("reads today's date in Lagos, an hour ahead of UTC", () => {
    expect(watDate(new Date('2026-10-03T22:59:00Z'))).toBe('2026-10-03')
    expect(watDate(new Date('2026-10-03T23:00:00Z'))).toBe('2026-10-04')
  })

  it('counts days across months and bounds a day in WAT', () => {
    expect(addDays('2026-10-03', -29)).toBe('2026-09-04')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(watDayStart('2026-10-03')).toBe('2026-10-03T00:00:00+01:00')
    expect(watDayEnd('2026-10-03')).toBe('2026-10-04T00:00:00+01:00')
  })
})

describe('the refund a failed line queues (enqueue_line_refund)', () => {
  it('is the price plus the VAT, for a one-line order', () => {
    expect(
      lineRefundKobo(
        [{ id: 'a', priceKobo: 100_000, createdAt: '2026-10-03T10:00:00Z' }],
        { subtotalKobo: 100_000, vatKobo: 7_500 },
        'a',
      ),
    ).toBe(107_500)
  })

  it('floors each share over the running total, so the shares add up to the VAT exactly', () => {
    const lines = [
      { id: 'b', priceKobo: 333_333, createdAt: '2026-10-03T10:00:00Z' },
      { id: 'a', priceKobo: 333_333, createdAt: '2026-10-03T10:00:00Z' },
      { id: 'c', priceKobo: 333_334, createdAt: '2026-10-03T09:00:00Z' },
    ]
    const order = { subtotalKobo: 1_000_000, vatKobo: 75_001 }
    const refunds = ['a', 'b', 'c'].map((id) => lineRefundKobo(lines, order, id) ?? 0)
    // (created_at, id) order: c, then a, then b — the last share takes the rounding.
    expect(refunds).toEqual([333_333 + 25_000, 333_333 + 25_001, 333_334 + 25_000])
    expect(refunds.reduce((sum, value) => sum + value, 0)).toBe(1_075_001)
  })

  it('stays exact past 2^53 (N5)', () => {
    const lines = [
      { id: 'a', priceKobo: 4_000_000_000_000, createdAt: '2026-10-03T10:00:00Z' },
      { id: 'b', priceKobo: 4_000_000_000_001, createdAt: '2026-10-03T10:00:01Z' },
    ]
    const order = { subtotalKobo: 8_000_000_000_001, vatKobo: 600_000_000_001 }
    const a = lineRefundKobo(lines, order, 'a') ?? 0
    const b = lineRefundKobo(lines, order, 'b') ?? 0
    expect(a + b).toBe(8_600_000_000_002)
  })

  it('names no figure when SQL would not refund it as a line', () => {
    const lines = [{ id: 'a', priceKobo: 100_000, createdAt: '2026-10-03T10:00:00Z' }]
    expect(lineRefundKobo(lines, { subtotalKobo: 90_000, vatKobo: 0 }, 'a')).toBeNull()
    expect(lineRefundKobo(lines, { subtotalKobo: 0, vatKobo: 0 }, 'a')).toBeNull()
    expect(lineRefundKobo(lines, { subtotalKobo: 100_000, vatKobo: 0 }, 'z')).toBeNull()
  })

  const refund = (overrides: Partial<LineRefund>): LineRefund => ({
    id: 'r1',
    status: 'queued',
    amountKobo: 107_500,
    providerRefundId: null,
    ...overrides,
  })

  it('re-queues a cancelled refund at its own amount', () => {
    expect(failRefundKobo([refund({ status: 'cancelled', amountKobo: 99_000 })], 107_500)).toBe(
      99_000,
    )
    expect(
      failRefundKobo([refund({ status: 'cancelled', providerRefundId: 'flw-1' })], 107_500),
    ).toBe(107_500)
    expect(failRefundKobo([], null)).toBeNull()
  })

  it('finds the open refund a retry would cancel, and whether it reached Flutterwave', () => {
    expect(openLineRefund([refund({ status: 'cancelled' }), refund({ id: 'r2' })])?.id).toBe('r2')
    expect(openLineRefund([refund({ status: 'cancelled' })])).toBeNull()
    expect(refundAtProvider(null)).toBe(false)
    expect(refundAtProvider(refund({ status: 'held' }))).toBe(false)
    for (const status of ['sending', 'submitted', 'completed']) {
      expect(refundAtProvider(refund({ status }))).toBe(true)
    }
    expect(refundAtProvider(refund({ status: 'failed', providerRefundId: 'flw-1' }))).toBe(true)
  })
})

describe("whether a read lets Fail go ahead (admin_fail_job's rule)", () => {
  const now = new Date('2026-10-03T12:00:00Z')
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()

  it('needs a read at all', () => {
    expect(readVerdict('registry', null, null, now)).toBe('none')
  })

  it('needs it in the last 15 minutes', () => {
    expect(
      readVerdict(
        'registry',
        { createdAt: at(READ_WINDOW_MS + 1000), outcome: 'not_found' },
        null,
        now,
      ),
    ).toBe('stale')
    expect(
      readVerdict('registry', { createdAt: 'nonsense', outcome: 'not_found' }, null, now),
    ).toBe('stale')
  })

  it('needs it after the last attempt', () => {
    expect(
      readVerdict('registry', { createdAt: at(60_000), outcome: 'not_found' }, at(30_000), now),
    ).toBe('before_attempt')
  })

  it('needs a registry read that finds the domain missing', () => {
    expect(readVerdict('registry', { createdAt: at(60_000), outcome: 'ok' }, null, now)).toBe(
      'not_qualifying',
    )
    expect(
      readVerdict('registry', { createdAt: at(60_000), outcome: 'not_found' }, at(120_000), now),
    ).toBe('ok')
  })

  it('needs a transfer read that shows a refusal or a cancellation', () => {
    const read = { createdAt: at(60_000), outcome: 'ok' }
    expect(readVerdict('transfer', { ...read, state: 'rejected' }, null, now)).toBe('ok')
    expect(readVerdict('transfer', { ...read, state: 'cancelled' }, null, now)).toBe('ok')
    expect(readVerdict('transfer', { ...read, state: 'pending' }, null, now)).toBe('not_qualifying')
    expect(
      readVerdict('transfer', { ...read, outcome: 'failed', state: 'rejected' }, null, now),
    ).toBe('not_qualifying')
  })
})

describe('paid lines with no job', () => {
  it('counts pending domain lines without a job, and leaves certificate lines to SQL', () => {
    const lines = [
      { id: '1', orderId: 'o', itemType: 'register', status: 'pending' },
      { id: '2', orderId: 'o', itemType: 'renew', status: 'pending' },
      { id: '3', orderId: 'o', itemType: 'transfer', status: 'failed' },
      { id: '4', orderId: 'o', itemType: 'ssl', status: 'pending' },
      { id: '5', orderId: 'o', itemType: 'transfer', status: 'pending' },
    ]
    expect(linesWithoutJob(lines, new Set(['2'])).map((line) => line.id)).toEqual(['1', '5'])
  })
})
