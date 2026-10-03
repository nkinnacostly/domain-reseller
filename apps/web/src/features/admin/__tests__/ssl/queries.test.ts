import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSslListParams } from '@/features/admin/lib/ssl-params'
import {
  CALLS_SHOWN,
  getCertificate,
  getSslStats,
  listCertificates,
  listPaidWithoutCertificate,
  PAID_GRACE_MS,
  SslReadError,
} from '@/features/admin/queries/ssl'
import { createClient } from '@/lib/supabase/server'
import { sessionClient } from '../foundation/fixtures'
import { certificateRow, fakeService, filterOf, ids, NOW, principal, type Read } from './fake-db'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const byTable = (reads: Read[], table: string) => reads.filter((read) => read.table === table)

/** Columns no certificate read may name: the CSR, contact, approver's address, a key (D4, N13). */
const NEVER = /(^|[\s,(])(csr|contact|approver_email|private_key|message|last_error)([\s,)]|$)/

beforeEach(() => vi.clearAllMocks())

describe('listCertificates', () => {
  it('reads one page of the side through the masked view, filtered and sorted from the URL', async () => {
    const reads = fakeService(() => ({ data: [certificateRow()], count: 31 }))
    const admin = await principal({ role: 'operator', testOnly: true })
    const params = parseSslListParams({
      status: 'issued,failed',
      unrecognised: '1',
      line: ids.line,
      q: 'shop.example.com',
      from: '2026-10-01',
      to: '2026-10-03',
      sort: 'expires',
      dir: 'asc',
      page: '2',
    })
    const list = await listCertificates(admin, 'live', params)

    expect(list.total).toBe(31)
    expect(list.rows).toEqual([
      expect.objectContaining({
        id: ids.certificate,
        commonName: 'shop.example.com',
        status: 'issued',
        supplierStatus: 'Active',
        testMode: true,
        reissueCount: 0,
      }),
    ])
    const [read] = reads
    expect(read?.table).toBe('admin_ssl_certificates_v')
    expect(read?.options).toEqual({ count: 'exact' })
    expect(read?.select).not.toMatch(NEVER)
    // A test admin reads the test side, whatever the cookie says (D15).
    expect(filterOf(read, 'eq', 'test_mode')).toBe(true)
    expect(filterOf(read, 'in', 'status')).toEqual(['issued', 'failed'])
    expect(read?.filters).toContainEqual(['not', 'status_unrecognised_since', 'is', null])
    expect(filterOf(read, 'eq', 'order_item_id')).toBe(ids.line)
    expect(filterOf(read, 'in', 'common_name')).toEqual(['shop.example.com', '*.shop.example.com'])
    expect(filterOf(read, 'gte', 'created_at')).toBe('2026-10-01T00:00:00+01:00')
    expect(filterOf(read, 'lt', 'created_at')).toBe('2026-10-04T00:00:00+01:00')
    expect(read?.filters).toContainEqual([
      'order',
      'expires_at',
      { ascending: true, nullsFirst: false },
    ])
    expect(read?.filters).toContainEqual(['order', 'id', { ascending: true }])
    expect(read?.filters).toContainEqual(['range', 25, 49])
  })

  it('applies no filter it was not asked for, on the side asked', async () => {
    const reads = fakeService(() => ({ data: [] }))
    const admin = await principal()
    const list = await listCertificates(admin, 'live', parseSslListParams({}))
    expect(list).toEqual({ rows: [], total: 0 })
    const [read] = reads
    expect(filterOf(read, 'eq', 'test_mode')).toBe(false)
    expect(read?.filters.map(([method]) => method)).toEqual(['eq', 'order', 'order', 'range'])
  })

  it('drops a row without an id or a name, and fails loudly rather than look empty', async () => {
    fakeService(() => ({
      data: [certificateRow({ id: null }), certificateRow({ common_name: null })],
    }))
    const admin = await principal()
    expect((await listCertificates(admin, 'test', parseSslListParams({}))).rows).toEqual([])

    fakeService(() => ({ error: { message: 'down', code: '57014' } }))
    await expect(listCertificates(admin, 'test', parseSslListParams({}))).rejects.toBeInstanceOf(
      SslReadError,
    )
  })
})

describe('getSslStats', () => {
  it('asks SQL for the side’s figures and sums them', async () => {
    const session = sessionClient({
      rpc: {
        admin_ssl_stats: {
          data: {
            byStatus: [
              { status: 'issued', count: 3 },
              { status: 'failed', count: '2' },
            ],
            unrecognised: 1,
            jobs: [
              { kind: 'ssl_initialize', status: 'needs_attention', count: 2 },
              { kind: 'ssl_configure', status: 'needs_attention', count: 1 },
              { kind: 'ssl_configure', status: 'queued', count: 4 },
              { kind: 'ssl_reissue', status: 'running', count: 1 },
              { kind: 'ssl_reissue', status: 'succeeded', count: 9 },
            ],
          },
        },
      },
    })
    vi.mocked(createClient).mockResolvedValue(session.client as never)
    const stats = await getSslStats('test')
    expect(session.rpc).toHaveBeenCalledWith('admin_ssl_stats', { p_test_mode: true })
    expect(stats).toEqual({
      byStatus: { issued: 3, failed: 2 },
      total: 5,
      unrecognised: 1,
      jobsNeedingPerson: 3,
      jobsOpen: 5,
    })
  })

  it('reads an odd answer as nothing, and a refusal as an error', async () => {
    const odd = sessionClient({ rpc: { admin_ssl_stats: { data: { byStatus: 'x' } } } })
    vi.mocked(createClient).mockResolvedValue(odd.client as never)
    expect(await getSslStats('live')).toEqual({
      byStatus: {},
      total: 0,
      unrecognised: 0,
      jobsNeedingPerson: 0,
      jobsOpen: 0,
    })
    expect(odd.rpc).toHaveBeenCalledWith('admin_ssl_stats', { p_test_mode: false })

    const refused = sessionClient({
      rpc: { admin_ssl_stats: { error: { message: 'admin:test_admin' } } },
    })
    vi.mocked(createClient).mockResolvedValue(refused.client as never)
    await expect(getSslStats('live')).rejects.toBeInstanceOf(SslReadError)
  })
})

describe('listPaidWithoutCertificate', () => {
  it('lists paid certificate lines no certificate holds, past the grace minutes', async () => {
    const other = '9a3b3c3d-4e4f-4a5b-8c6d-7e7f8a8b9c9d'
    const reads = fakeService((read) => {
      if (read.table === 'admin_orders_v') {
        return {
          data: [{ id: ids.order, order_number: 'ND-001040', paid_at: '2026-10-03T10:00:00Z' }],
        }
      }
      if (read.table === 'order_items') {
        return {
          data: [
            {
              id: ids.line,
              order_id: ids.order,
              domain: 'held.example.com',
              ssl_product_code: '351',
            },
            { id: other, order_id: ids.order, domain: 'lost.example.com', ssl_product_code: '352' },
          ],
        }
      }
      return { data: [{ order_item_id: ids.line }] }
    })
    const admin = await principal()
    const lines = await listPaidWithoutCertificate(admin, 'test', NOW)
    expect(lines).toEqual([
      {
        id: other,
        orderId: ids.order,
        orderNumber: 'ND-001040',
        name: 'lost.example.com',
        productCode: '352',
        paidAt: '2026-10-03T10:00:00Z',
      },
    ])
    const [orders, items, certificates] = reads
    expect(filterOf(orders, 'eq', 'test_mode')).toBe(true)
    expect(filterOf(orders, 'lt', 'paid_at')).toBe(
      new Date(NOW.getTime() - PAID_GRACE_MS).toISOString(),
    )
    expect(orders?.filters).toContainEqual(['not', 'payment_id', 'is', null])
    expect(filterOf(items, 'eq', 'item_type')).toBe('ssl')
    expect(filterOf(items, 'eq', 'status')).toBe('pending')
    // The line's side comes from its order, through adminDb's own embed.
    expect(filterOf(items, 'eq', 'admin_side.test_mode')).toBe(true)
    expect(certificates?.table).toBe('admin_ssl_certificates_v')
    expect(filterOf(certificates, 'in', 'order_item_id')).toEqual([ids.line, other])
  })

  it('reads no further than it has to', async () => {
    const reads = fakeService(() => ({ data: [] }))
    const admin = await principal()
    expect(await listPaidWithoutCertificate(admin, 'test', NOW)).toEqual([])
    expect(reads.map((read) => read.table)).toEqual(['admin_orders_v'])

    const twoReads = fakeService((read) =>
      read.table === 'admin_orders_v'
        ? { data: [{ id: ids.order, order_number: 'ND-1', paid_at: null }] }
        : { data: [] },
    )
    expect(await listPaidWithoutCertificate(admin, 'test', NOW)).toEqual([])
    expect(twoReads.map((read) => read.table)).toEqual(['admin_orders_v', 'order_items'])
  })

  it('names the order by id when its number could not be read', async () => {
    fakeService((read) => {
      if (read.table === 'admin_orders_v') return { data: [{ id: null }, { id: ids.order }] }
      if (read.table === 'order_items') {
        return {
          data: [
            { id: ids.line, order_id: ids.job, domain: 'x.example.com', ssl_product_code: null },
          ],
        }
      }
      return { data: [{ order_item_id: null }] }
    })
    const admin = await principal()
    expect(await listPaidWithoutCertificate(admin, 'test', NOW)).toEqual([
      expect.objectContaining({ orderNumber: null, paidAt: null, productCode: null }),
    ])
  })
})

describe('getCertificate', () => {
  function answers(overrides: Partial<Record<string, (read: Read) => unknown>> = {}) {
    return fakeService((read) => {
      const custom = overrides[read.table]
      if (custom) return custom(read) as never
      switch (read.table) {
        case 'admin_ssl_certificates_v':
          return { data: [certificateRow()] }
        case 'order_items':
          return {
            data: [
              {
                id: ids.line,
                order_id: ids.order,
                domain: 'shop.example.com',
                price_kobo: '1350000',
                renewal_kobo: 1_350_000,
                status: 'completed',
                failure_code: null,
              },
            ],
          }
        case 'admin_orders_v':
          return { data: [{ id: ids.order, order_number: 'ND-001040' }] }
        case 'ssl_jobs':
          return {
            data: [
              {
                id: ids.job,
                kind: 'ssl_initialize',
                status: 'succeeded',
                attempts: 1,
                last_error_code: null,
                sent_at: '2026-10-01T10:00:00Z',
                run_after: '2026-10-01T10:00:00Z',
                created_at: '2026-10-01T09:59:00Z',
                finished_at: '2026-10-01T10:00:05Z',
              },
            ],
          }
        case 'refunds':
          return {
            data: [
              {
                id: ids.refund,
                status: 'cancelled',
                amount_kobo: '100',
                reason: 'ssl_failed',
                created_at: '2026-10-02T09:00:00Z',
              },
            ],
          }
        case 'supplier_calls':
          return {
            data: [
              {
                id: 7,
                created_at: '2026-10-03T11:05:00Z',
                operation: 'AdminSslCheckStatus',
                outcome: 'ok',
                error_code: null,
                http_status: 200,
                duration_ms: 420,
                ssl_job_id: null,
              },
            ],
          }
        default:
          return { data: [] }
      }
    })
  }

  it('reads the certificate through the masked view, and its parts on the same side', async () => {
    const reads = answers()
    const admin = await principal({ role: 'viewer' })
    const detail = await getCertificate(admin, 'test', ids.certificate)
    if (!detail) throw new Error('no detail')

    expect(detail.certificate).toMatchObject({
      id: ids.certificate,
      approverMasked: 'a•••@shop.example.com',
      certificatePem: expect.stringContaining('BEGIN CERTIFICATE'),
      sanNames: [],
      includedNames: 1,
      orderItemId: ids.line,
    })
    expect(detail.line).toEqual({
      ok: true,
      data: {
        id: ids.line,
        orderId: ids.order,
        orderNumber: 'ND-001040',
        name: 'shop.example.com',
        priceKobo: 1_350_000,
        renewalKobo: 1_350_000,
        status: 'completed',
        failureCode: null,
      },
    })
    expect(detail.jobs).toMatchObject({ ok: true, data: [{ id: ids.job, kind: 'ssl_initialize' }] })
    expect(detail.refunds).toEqual({
      ok: true,
      data: [
        {
          id: ids.refund,
          status: 'cancelled',
          amountKobo: 100,
          reason: 'ssl_failed',
          createdAt: '2026-10-02T09:00:00Z',
        },
      ],
    })
    expect(detail.calls).toMatchObject({
      ok: true,
      data: [{ id: 7, operation: 'AdminSslCheckStatus', sslJobId: null }],
    })

    for (const read of reads) expect(read.select ?? '', read.table).not.toMatch(NEVER)
    const [certificate] = byTable(reads, 'admin_ssl_certificates_v')
    expect(filterOf(certificate, 'eq', 'id')).toBe(ids.certificate)
    expect(filterOf(certificate, 'eq', 'test_mode')).toBe(true)
    expect(certificate?.select).toContain('approver_masked')
    const [calls] = byTable(reads, 'supplier_calls')
    expect(filterOf(calls, 'eq', 'environment')).toBe('ote')
    expect(filterOf(calls, 'eq', 'domain_name')).toBe('shop.example.com')
    expect(filterOf(calls, 'gte', 'created_at')).toBe('2026-10-01T09:59:00Z')
    expect(calls?.filters).toContainEqual(['limit', CALLS_SHOWN])
    expect(filterOf(byTable(reads, 'ssl_jobs')[0], 'eq', 'certificate_id')).toBe(ids.certificate)
    expect(filterOf(byTable(reads, 'refunds')[0], 'eq', 'order_item_id')).toBe(ids.line)
  })

  it('is null for a certificate this side does not have', async () => {
    const reads = answers({ admin_ssl_certificates_v: () => ({ data: [] }) })
    const admin = await principal()
    expect(await getCertificate(admin, 'live', ids.certificate)).toBeNull()
    expect(reads).toHaveLength(1)

    answers({ admin_ssl_certificates_v: () => ({ data: [certificateRow({ common_name: null })] }) })
    expect(await getCertificate(admin, 'live', ids.certificate)).toBeNull()
  })

  it('fails as a whole only when the certificate itself cannot be read', async () => {
    answers({ admin_ssl_certificates_v: () => ({ error: { message: 'down' } }) })
    const admin = await principal()
    await expect(getCertificate(admin, 'test', ids.certificate)).rejects.toBeInstanceOf(
      SslReadError,
    )
  })

  it('gives each other part its own error state', async () => {
    answers({
      order_items: () => ({ error: { message: 'down' } }),
      ssl_jobs: () => ({ error: { message: 'down' } }),
      refunds: () => ({ error: { message: 'down' } }),
      supplier_calls: () => ({ error: { message: 'down' } }),
    })
    const admin = await principal()
    const detail = await getCertificate(admin, 'test', ids.certificate)
    expect(detail).toMatchObject({
      line: { ok: false },
      jobs: { ok: false },
      refunds: { ok: false },
      calls: { ok: false },
    })
  })

  it('reads a certificate with no line, no order number and no dates', async () => {
    const reads = answers({
      admin_ssl_certificates_v: () => ({
        data: [
          certificateRow({
            order_item_id: null,
            created_at: null,
            included_names: null,
            san_names: null,
            reissue_count: null,
            is_wildcard: null,
            test_mode: null,
            status: null,
          }),
        ],
      }),
    })
    const admin = await principal()
    const detail = await getCertificate(admin, 'test', ids.certificate)
    expect(detail).toMatchObject({
      certificate: {
        includedNames: 1,
        sanNames: [],
        reissueCount: 0,
        isWildcard: false,
        testMode: false,
        status: '',
      },
      line: { ok: true, data: null },
      refunds: { ok: true, data: [] },
    })
    expect(byTable(reads, 'order_items')).toHaveLength(0)
    expect(filterOf(byTable(reads, 'supplier_calls')[0], 'gte', 'created_at')).toBeUndefined()

    answers({
      order_items: () => ({ data: [] }),
    })
    const lineless = await getCertificate(admin, 'test', ids.certificate)
    expect(lineless?.line).toEqual({ ok: true, data: null })

    answers({ admin_orders_v: () => ({ data: [] }) })
    const numberless = await getCertificate(admin, 'test', ids.certificate)
    expect(numberless?.line).toMatchObject({ ok: true, data: { orderNumber: null } })
  })
})
