import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseListParams } from '@/features/admin/lib/list-params'
import { JOB_LIST_SPEC } from '@/features/admin/lib/queue-facts'
import { getAttentionCounts } from '@/features/admin/queries/attention'
import {
  getJob,
  getQueueStats,
  getSslJob,
  listJobs,
  listPendingWithoutJob,
  listSslJobs,
  QueueReadError,
} from '@/features/admin/queries/queue'
import { type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/features/admin/queries/session', () => ({ adminDb: vi.fn() }))
vi.mock('@/features/admin/queries/attention', () => ({ getAttentionCounts: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

type Answer = { data?: unknown; error?: { code?: string; message: string } | null; count?: number }
type Call = { table: string; columns: string; options?: unknown; steps: [string, unknown[]][] }

/**
 * adminDb as the queue sees it: each read records its table, its columns and
 * every filter, and answers the next answer queued for that table.
 */
function fakeDb(answers: Record<string, Answer[]>) {
  const calls: Call[] = []
  const queues = new Map(Object.entries(answers).map(([table, list]) => [table, [...list]]))
  const db = {
    from(table: string) {
      return {
        select(columns: string, options?: unknown) {
          const call: Call = { table, columns, options, steps: [] }
          calls.push(call)
          const answer = () => {
            const list = queues.get(table)
            const next = list && list.length > 1 ? list.shift() : list?.[0]
            if (!next) throw new Error(`no answer for ${table}`)
            return { data: next.data ?? null, error: next.error ?? null, count: next.count ?? null }
          }
          // A real promise, answered after the filters are chained (in the
          // order the reads began), with the builder's methods on it.
          const builder: Record<string, unknown> = Promise.resolve().then(answer) as never
          for (const method of ['eq', 'neq', 'in', 'not', 'gte', 'lt', 'order', 'range', 'limit']) {
            builder[method] = (...args: unknown[]) => {
              call.steps.push([method, args])
              return builder
            }
          }
          builder.maybeSingle = () => {
            call.steps.push(['maybeSingle', []])
            return builder
          }
          return builder
        },
      }
    },
  }
  vi.mocked(adminDb).mockReturnValue(db as never)
  return calls
}

const admin = { role: 'operator', testOnly: true } as unknown as AdminPrincipal
const JOB = '3c9e6b1a-1d2f-4e5a-8b7c-6d5e4f3a2b1c'
const DOMAIN = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const LINE = '9f8e7d6c-5b4a-4321-8fed-cba987654321'
const ORDER = '1e2d3c4b-5a69-4788-9a6b-5c4d3e2f1a0b'

const jobRow = {
  id: JOB,
  kind: 'register_domain',
  status: 'failed',
  attempts: 2,
  last_error_code: 'DOMAIN_TAKEN',
  run_after: '2026-10-03T10:00:00Z',
  created_at: '2026-10-03T09:00:00Z',
  updated_at: '2026-10-03T10:00:00Z',
  finished_at: '2026-10-03T10:00:00Z',
  submitted_at: null,
  baseline_expiry: null,
  locked_at: null,
  locked_by: null,
  test_mode: true,
  domain_id: DOMAIN,
  order_item_id: LINE,
}

/** The session client's rpc, answering by function name; anything else is an error. */
function session(answers: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const rpc = vi.fn(async (name: string, _args?: unknown) => {
    const answer = answers[name]
    if (!answer) return { data: null, error: { code: 'TEST', message: `no answer for ${name}` } }
    return { data: answer.data ?? null, error: answer.error ?? null }
  })
  vi.mocked(createClient).mockResolvedValue({ rpc } as never)
  return rpc
}

const LEDGER = {
  jobId: JOB,
  since: '2026-10-03T09:00:00.123+00:00',
  syncedAt: '2026-10-03T11:15:05+00:00',
  outcome: 'ok',
  readAt: '2026-10-03T11:15:00+00:00',
  charges: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  session()
})

describe('listJobs', () => {
  it('applies every filter, sorts with a stable tie-break, and names domains from the masked view', async () => {
    const calls = fakeDb({
      jobs: [{ data: [jobRow], count: 31 }],
      admin_domains_v: [{ data: [{ id: DOMAIN, domain_name: 'example.com' }] }],
    })
    const params = parseListParams(
      {
        status: 'failed',
        from: '2026-10-01',
        to: '2026-10-03',
        sort: 'attempts',
        dir: 'asc',
        page: '2',
      },
      JOB_LIST_SPEC,
    )
    const page = await listJobs(admin, 'test', params, {
      kind: 'register_domain',
      domainId: DOMAIN,
    })

    expect(adminDb).toHaveBeenCalledWith(admin, 'test')
    expect(page.total).toBe(31)
    expect(page.rows).toEqual([
      expect.objectContaining({
        id: JOB,
        domainName: 'example.com',
        lastErrorCode: 'DOMAIN_TAKEN',
      }),
    ])
    const [jobs, names] = calls
    expect(jobs?.options).toEqual({ count: 'exact' })
    expect(jobs?.steps).toEqual([
      ['in', ['status', ['failed']]],
      ['eq', ['kind', 'register_domain']],
      ['eq', ['domain_id', DOMAIN]],
      ['gte', ['created_at', '2026-10-01T00:00:00+01:00']],
      ['lt', ['created_at', '2026-10-04T00:00:00+01:00']],
      ['order', ['attempts', { ascending: true }]],
      ['order', ['id', { ascending: true }]],
      ['range', [25, 49]],
    ])
    expect(names?.table).toBe('admin_domains_v')
    expect(names?.steps).toEqual([['in', ['id', [DOMAIN]]]])
  })

  it('reads no names for an empty page, and fails loudly rather than showing an empty one', async () => {
    const calls = fakeDb({ jobs: [{ data: [], count: 0 }] })
    expect(
      await listJobs(admin, 'live', parseListParams({}, JOB_LIST_SPEC), {
        kind: null,
        domainId: null,
      }),
    ).toEqual({
      rows: [],
      total: 0,
    })
    expect(calls).toHaveLength(1)

    fakeDb({ jobs: [{ error: { code: '57014', message: 'timeout' } }] })
    await expect(
      listJobs(admin, 'live', parseListParams({}, JOB_LIST_SPEC), { kind: null, domainId: null }),
    ).rejects.toBeInstanceOf(QueueReadError)
  })
})

describe('listSslJobs', () => {
  it('lists certificate jobs with their filters', async () => {
    const calls = fakeDb({
      ssl_jobs: [
        {
          data: [
            {
              id: JOB,
              kind: 'ssl_initialize',
              status: 'needs_attention',
              attempts: 1,
              last_error_code: null,
              run_after: '2026-10-03T10:00:00Z',
              sent_at: null,
              created_at: '2026-10-03T09:00:00Z',
              updated_at: '2026-10-03T10:00:00Z',
              test_mode: true,
              certificate_id: DOMAIN,
            },
          ],
          count: 1,
        },
      ],
    })
    const page = await listSslJobs(
      admin,
      'test',
      parseListParams(
        { status: 'needs_attention', from: '2026-10-01', to: '2026-10-02' },
        JOB_LIST_SPEC,
      ),
      { kind: 'ssl_initialize', domainId: null },
    )
    expect(page).toEqual({
      total: 1,
      rows: [expect.objectContaining({ id: JOB, certificateId: DOMAIN, sentAt: null })],
    })
    expect(calls[0]?.steps.slice(0, 4)).toEqual([
      ['in', ['status', ['needs_attention']]],
      ['eq', ['kind', 'ssl_initialize']],
      ['gte', ['created_at', '2026-10-01T00:00:00+01:00']],
      ['lt', ['created_at', '2026-10-03T00:00:00+01:00']],
    ])
  })
})

describe('getQueueStats', () => {
  it('counts what needs a person and what the worker holds, with the last 30 WAT days', async () => {
    fakeDb({ jobs: [{ count: 3 }, { count: 5 }], ssl_jobs: [{ count: 1 }, { count: 0 }] })
    const rpc = vi.fn(async () => ({
      data: {
        jobs: [{ kind: 'register_domain', status: 'succeeded', count: '4' }],
        ssl: 'not a list',
        lines: [],
      },
      error: null,
    }))
    vi.mocked(createClient).mockResolvedValue({ rpc } as never)
    const stats = await getQueueStats(admin, 'test', new Date('2026-10-03T12:00:00Z'))
    expect(rpc).toHaveBeenCalledWith('admin_provisioning', {
      p_test_mode: true,
      p_from: '2026-09-04',
      p_to: '2026-10-03',
    })
    expect(stats).toEqual({
      needsAttention: { jobs: 3, ssl: 1 },
      open: { jobs: 5, ssl: 0 },
      last30: {
        from: '2026-09-04',
        to: '2026-10-03',
        jobs: [{ kind: 'register_domain', status: 'succeeded', count: 4 }],
        ssl: [],
      },
    })
  })

  it('fails when a count or the aggregate cannot be read', async () => {
    fakeDb({ jobs: [{ error: { message: 'down' } }], ssl_jobs: [{ count: 0 }] })
    vi.mocked(createClient).mockResolvedValue({
      rpc: async () => ({ data: {}, error: null }),
    } as never)
    await expect(getQueueStats(admin, 'live', new Date())).rejects.toBeInstanceOf(QueueReadError)

    fakeDb({ jobs: [{ count: 0 }], ssl_jobs: [{ count: 0 }] })
    vi.mocked(createClient).mockResolvedValue({
      rpc: async () => ({ data: null, error: { code: '42501', message: 'admin:test_admin' } }),
    } as never)
    await expect(getQueueStats(admin, 'live', new Date())).rejects.toBeInstanceOf(QueueReadError)
  })
})

describe('listPendingWithoutJob', () => {
  const now = new Date('2026-10-03T12:00:00Z')

  it('lists paid domain lines with no job, and counts the certificate lines SQL found', async () => {
    const calls = fakeDb({
      admin_orders_v: [
        { data: [{ id: ORDER, order_number: 'MDH-1001', paid_at: '2026-10-03T11:00:00Z' }] },
      ],
      order_items: [
        {
          data: [
            {
              id: LINE,
              order_id: ORDER,
              domain: 'a.com',
              item_type: 'register',
              status: 'pending',
            },
            { id: JOB, order_id: ORDER, domain: 'b.com', item_type: 'register', status: 'pending' },
            { id: DOMAIN, order_id: ORDER, domain: 'c.com', item_type: 'ssl', status: 'pending' },
          ],
        },
      ],
      jobs: [{ data: [{ order_item_id: JOB }] }],
    })
    vi.mocked(getAttentionCounts).mockResolvedValue({ pendingWithoutJob: 3 } as never)
    const report = await listPendingWithoutJob(admin, 'test', now)
    expect(report).toEqual({
      rows: [
        {
          id: LINE,
          orderId: ORDER,
          orderNumber: 'MDH-1001',
          domain: 'a.com',
          itemType: 'register',
          status: 'pending',
          paidAt: '2026-10-03T11:00:00Z',
        },
      ],
      certificateLines: 2,
    })
    expect(calls[0]?.steps).toEqual([
      ['not', ['payment_id', 'is', null]],
      ['in', ['status', ['paid', 'provisioning']]],
      ['lt', ['paid_at', '2026-10-03T11:55:00.000Z']],
      ['order', ['paid_at', { ascending: true }]],
      ['limit', [100]],
    ])
  })

  it('answers no rows when no paid order is waiting, and no certificate count when it is unknown', async () => {
    fakeDb({ admin_orders_v: [{ data: [] }] })
    vi.mocked(getAttentionCounts).mockResolvedValue(null)
    expect(await listPendingWithoutJob(admin, 'live', now)).toEqual({
      rows: [],
      certificateLines: null,
    })

    fakeDb({
      admin_orders_v: [{ data: [{ id: ORDER, order_number: null, paid_at: null }] }],
      order_items: [{ data: [] }],
    })
    vi.mocked(getAttentionCounts).mockResolvedValue({ pendingWithoutJob: 0 } as never)
    expect(await listPendingWithoutJob(admin, 'live', now)).toEqual({
      rows: [],
      certificateLines: 0,
    })
  })
})

describe('getJob', () => {
  it('reads the job, its domain, line, refunds, calls, reads and events', async () => {
    const rpc = session({ admin_job_ledger: { data: LEDGER } })
    const calls = fakeDb({
      jobs: [{ data: jobRow }],
      admin_domains_v: [
        {
          data: {
            id: DOMAIN,
            domain_name: 'example.com',
            local_status: 'registration_failed',
            expires_at: null,
            transfer_lock: null,
            privacy_enabled: false,
            pending_transfer_lock: null,
            pending_privacy: null,
            source: 'registration',
          },
        },
      ],
      order_items: [
        {
          data: {
            id: LINE,
            order_id: ORDER,
            item_type: 'register',
            domain: 'example.com',
            period_years: 1,
            renewal_years: 1,
            price_kobo: 100_000,
            renewal_kobo: 100_000,
            status: 'failed',
            failure_code: 'DOMAIN_TAKEN',
          },
        },
        { data: [{ id: LINE, price_kobo: 100_000, created_at: '2026-10-03T08:00:00Z' }] },
      ],
      refunds: [
        {
          data: [
            {
              id: ORDER,
              status: 'queued',
              amount_kobo: 107_500,
              reason: 'registration_failed',
              provider_refund_id: null,
              last_error_code: null,
              created_at: '2026-10-03T10:00:00Z',
              updated_at: '2026-10-03T10:00:00Z',
            },
          ],
        },
      ],
      supplier_calls: [
        {
          data: [
            {
              id: 2,
              created_at: '2026-10-03T09:59:00Z',
              operation: 'RegisterWithContactInfo',
              outcome: 'refused',
              error_code: 'DOMAIN_TAKEN',
              http_status: 403,
              duration_ms: 1200,
            },
            {
              id: 1,
              created_at: '2026-10-03T09:58:00Z',
              operation: 'GetDetails',
              outcome: 'not_found',
              error_code: null,
              http_status: 200,
              duration_ms: 300,
            },
          ],
        },
        { data: { created_at: '2026-10-03T09:58:00Z', outcome: 'not_found' } },
      ],
      domain_events: [
        {
          data: [
            {
              id: 9,
              event_type: 'registration_failed',
              actor_type: 'system',
              created_at: '2026-10-03T10:00:00Z',
            },
          ],
        },
      ],
      admin_orders_v: [
        { data: { order_number: 'MDH-1001', subtotal_kobo: 100_000, vat_kobo: 7_500 } },
      ],
    })

    const detail = await getJob(admin, 'test', JOB)
    expect(detail).toMatchObject({
      job: { id: JOB, kind: 'register_domain', status: 'failed', orderItemId: LINE },
      domain: { id: DOMAIN, name: 'example.com', localStatus: 'registration_failed' },
      line: { id: LINE, orderNumber: 'MDH-1001', priceKobo: 100_000 },
      order: { subtotalKobo: 100_000, vatKobo: 7_500 },
      orderLines: [{ id: LINE, priceKobo: 100_000 }],
      refunds: [{ status: 'queued', amountKobo: 107_500, providerRefundId: null }],
      registryRead: { createdAt: '2026-10-03T09:58:00Z', outcome: 'not_found' },
      transferRead: null,
      lastAttemptAt: '2026-10-03T09:59:00Z',
      ledger: {
        since: LEDGER.since,
        readAt: LEDGER.readAt,
        syncedAt: LEDGER.syncedAt,
        outcome: 'ok',
        charges: 0,
      },
      events: [{ id: 9, eventType: 'registration_failed' }],
    })
    // The ledger check is SQL's count, on the job's own side (migration 42).
    expect(rpc).toHaveBeenCalledWith('admin_job_ledger', { p_test_mode: true, p_job_id: JOB })
    expect(detail?.calls.map((call) => call.operation)).toEqual([
      'RegisterWithContactInfo',
      'GetDetails',
    ])
    const registry = calls.find(
      (call) => call.table === 'supplier_calls' && call.columns === 'created_at, outcome',
    )
    expect(registry?.steps).toContainEqual(['eq', ['domain_name', 'example.com']])
    expect(registry?.steps).toContainEqual(['in', ['operation', ['GetDetails', 'AdminGetDetails']]])
  })

  it('reads a transfer state for a transfer, keeping only our own state words', async () => {
    fakeDb({
      jobs: [
        {
          data: {
            ...jobRow,
            kind: 'transfer_domain',
            order_item_id: null,
            status: 'needs_attention',
          },
        },
      ],
      admin_domains_v: [{ data: { id: DOMAIN, domain_name: 'example.com' } }],
      supplier_calls: [
        { data: [] },
        { data: null },
        { data: { created_at: '2026-10-03T11:00:00Z', outcome: 'ok', message: 'rejected' } },
      ],
      domain_events: [{ data: [] }],
    })
    const rpc = session()
    const detail = await getJob(admin, 'test', JOB)
    expect(detail?.ledger).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
    expect(detail?.line).toBeNull()
    expect(detail?.order).toBeNull()
    expect(detail?.registryRead).toBeNull()
    expect(detail?.transferRead).toEqual({
      createdAt: '2026-10-03T11:00:00Z',
      outcome: 'ok',
      state: 'rejected',
    })
    expect(detail?.lastAttemptAt).toBeNull()

    fakeDb({
      jobs: [{ data: { ...jobRow, kind: 'transfer_domain', order_item_id: null } }],
      admin_domains_v: [{ data: { id: DOMAIN, domain_name: 'example.com' } }],
      supplier_calls: [
        { data: [] },
        { data: null },
        {
          data: { created_at: '2026-10-03T11:00:00Z', outcome: 'ok', message: 'Raw supplier text' },
        },
      ],
      domain_events: [{ data: [] }],
    })
    expect((await getJob(admin, 'test', JOB))?.transferRead?.state).toBeNull()
  })

  it('says the ledger is unreadable when SQL refuses or answers another shape', async () => {
    const answers = [
      { error: { code: '42501', message: 'admin:needs_code' } },
      { data: { ...LEDGER, charges: -1 } },
      { data: null },
    ]
    for (const answer of answers) {
      session({ admin_job_ledger: answer })
      fakeDb({
        jobs: [{ data: { ...jobRow, order_item_id: null, status: 'needs_attention' } }],
        admin_domains_v: [{ data: { id: DOMAIN, domain_name: 'example.com' } }],
        supplier_calls: [{ data: [] }, { data: null }],
        domain_events: [{ data: [] }],
      })
      expect((await getJob(admin, 'test', JOB))?.ledger).toBe('unreadable')
    }
  })

  it('answers null for a job this side does not have, and fails on a read error', async () => {
    fakeDb({ jobs: [{ data: null }] })
    expect(await getJob(admin, 'live', JOB)).toBeNull()

    fakeDb({
      jobs: [{ data: { ...jobRow, order_item_id: null } }],
      admin_domains_v: [{ data: null }],
      supplier_calls: [{ error: { message: 'down' } }],
      domain_events: [{ data: [] }],
    })
    await expect(getJob(admin, 'live', JOB)).rejects.toBeInstanceOf(QueueReadError)
  })
})

describe('getSslJob', () => {
  it('reads a certificate job, its name from its calls, and its siblings', async () => {
    fakeDb({
      ssl_jobs: [
        {
          data: {
            id: JOB,
            kind: 'ssl_configure',
            status: 'needs_attention',
            attempts: 1,
            last_error_code: 'SSL_TIMEOUT',
            run_after: '2026-10-03T10:00:00Z',
            sent_at: '2026-10-03T09:30:00Z',
            created_at: '2026-10-03T09:00:00Z',
            updated_at: '2026-10-03T10:00:00Z',
            finished_at: null,
            locked_at: null,
            locked_by: null,
            test_mode: true,
            certificate_id: DOMAIN,
          },
        },
        {
          data: [
            {
              id: LINE,
              kind: 'ssl_initialize',
              status: 'succeeded',
              created_at: '2026-10-02T09:00:00Z',
            },
          ],
        },
      ],
      supplier_calls: [
        {
          data: [
            {
              id: 5,
              created_at: '2026-10-03T09:30:00Z',
              operation: 'SslConfigure',
              outcome: 'unknown',
              error_code: null,
              http_status: null,
              duration_ms: 30_000,
              domain_name: 'example.com',
            },
          ],
        },
      ],
    })
    const detail = await getSslJob(admin, 'test', JOB)
    expect(detail).toMatchObject({
      job: {
        id: JOB,
        kind: 'ssl_configure',
        sentAt: '2026-10-03T09:30:00Z',
        certificateId: DOMAIN,
      },
      name: 'example.com',
      calls: [{ id: 5, operation: 'SslConfigure' }],
      siblings: [{ id: LINE, kind: 'ssl_initialize', status: 'succeeded' }],
    })
  })

  it('names an order by its certificate, with its line, order and refunds', async () => {
    const rpc = session({
      admin_ssl_job_certificate: { data: { commonName: '*.example.com', orderItemId: LINE } },
    })
    const calls = fakeDb({
      ssl_jobs: [
        {
          data: {
            id: JOB,
            kind: 'ssl_initialize',
            status: 'failed',
            attempts: 1,
            last_error_code: 'SSL_REFUSED',
            run_after: '2026-10-03T10:00:00Z',
            sent_at: null,
            created_at: '2026-10-03T09:00:00Z',
            updated_at: '2026-10-03T10:00:00Z',
            finished_at: '2026-10-03T10:00:00Z',
            locked_at: null,
            locked_by: null,
            test_mode: true,
            certificate_id: DOMAIN,
          },
        },
        { data: [] },
      ],
      supplier_calls: [{ data: [] }],
      order_items: [
        {
          data: {
            id: LINE,
            order_id: ORDER,
            item_type: 'ssl',
            domain: '*.example.com',
            period_years: 1,
            renewal_years: 1,
            price_kobo: 2_500_000,
            renewal_kobo: 2_600_000,
            status: 'failed',
            failure_code: 'SSL_REFUSED',
          },
        },
        { data: [{ id: LINE, price_kobo: 2_500_000, created_at: '2026-10-03T08:00:00Z' }] },
      ],
      refunds: [
        {
          data: [
            {
              id: ORDER,
              status: 'queued',
              amount_kobo: 2_687_500,
              reason: 'ssl_failed',
              provider_refund_id: null,
              last_error_code: null,
              created_at: '2026-10-03T10:00:00Z',
              updated_at: '2026-10-03T10:00:00Z',
            },
          ],
        },
      ],
      admin_orders_v: [
        { data: { order_number: 'MDH-1002', subtotal_kobo: 2_500_000, vat_kobo: 187_500 } },
      ],
    })
    const detail = await getSslJob(admin, 'test', JOB)
    expect(rpc).toHaveBeenCalledWith('admin_ssl_job_certificate', {
      p_test_mode: true,
      p_job_id: JOB,
    })
    expect(detail).toMatchObject({
      name: '*.example.com',
      line: { id: LINE, itemType: 'ssl', orderNumber: 'MDH-1002', priceKobo: 2_500_000 },
      order: { subtotalKobo: 2_500_000, vatKobo: 187_500 },
      orderLines: [{ id: LINE, priceKobo: 2_500_000 }],
      refunds: [{ id: ORDER, amountKobo: 2_687_500, status: 'queued' }],
    })
    // The certificate itself is never read here: its view is B10's (§9).
    expect(calls.some((call) => call.table === 'admin_ssl_certificates_v')).toBe(false)
    const [line] = calls.filter((call) => call.table === 'order_items')
    expect(line?.steps).toContainEqual(['eq', ['id', LINE]])
  })

  it('names a job from its calls, with no line, when SQL cannot say', async () => {
    for (const answer of [
      { error: { code: '42501', message: 'admin:test_admin' } },
      { data: null },
      { data: { commonName: 'example.com', orderItemId: 'not-a-line' } },
    ]) {
      session({ admin_ssl_job_certificate: answer })
      const calls = fakeDb({
        ssl_jobs: [
          {
            data: {
              id: JOB,
              kind: 'ssl_configure',
              status: 'needs_attention',
              attempts: 1,
              last_error_code: null,
              run_after: '2026-10-03T10:00:00Z',
              sent_at: null,
              created_at: '2026-10-03T09:00:00Z',
              updated_at: '2026-10-03T10:00:00Z',
              finished_at: null,
              locked_at: null,
              locked_by: null,
              test_mode: false,
              certificate_id: DOMAIN,
            },
          },
          { data: [] },
        ],
        supplier_calls: [
          {
            data: [
              {
                id: 5,
                created_at: '2026-10-03T09:30:00Z',
                operation: 'SslConfigure',
                outcome: 'ok',
                error_code: null,
                http_status: 200,
                duration_ms: 900,
                domain_name: 'from-calls.com',
              },
            ],
          },
        ],
      })
      const detail = await getSslJob(admin, 'live', JOB)
      expect(detail).toMatchObject({ name: 'from-calls.com', line: null, refunds: [], order: null })
      expect(calls.some((call) => call.table === 'order_items')).toBe(false)
    }
  })

  it('answers null when this side has no such job', async () => {
    const rpc = session()
    fakeDb({ ssl_jobs: [{ data: null }] })
    expect(await getSslJob(admin, 'test', JOB)).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})
