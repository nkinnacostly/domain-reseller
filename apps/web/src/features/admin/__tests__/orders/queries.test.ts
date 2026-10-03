import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseOrderListParams } from '@/features/admin/lib/orders-params'
import {
  getOrderDetail,
  getOrderFunnel,
  listOrders,
  maskedCustomers,
  ORDER_ID_CAP,
  OrdersReadError,
} from '@/features/admin/queries/orders'
import { createClient } from '@/lib/supabase/server'
import { sessionClient } from '../foundation/fixtures'
import { fakeService, filterOf, ids, principal, type Read } from './fake-db'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

type Rpc = Parameters<typeof sessionClient>[0]

function session(rpc: NonNullable<Rpc>['rpc'] = {}) {
  const client = sessionClient({ rpc })
  vi.mocked(createClient).mockResolvedValue(client.client as never)
  return client
}

const customerRow = (userId: string, masked: string) => ({
  user_id: userId,
  masked_email: masked,
  account_type: 'individual',
  joined_at: '2026-09-01T10:00:00Z',
  domains_held: 1,
  orders_paid: 1,
  total_paid_kobo: 1_870_000,
  has_totp: false,
  email_confirmed: true,
  last_sign_in_at: null,
  is_admin: false,
  total_count: 1,
})

const orderRow = {
  id: ids.order,
  order_number: 'ND-001035',
  test_mode: true,
  created_at: '2026-10-02T09:00:00Z',
  paid_at: '2026-10-02T09:01:00Z',
  user_id: ids.user,
  status: 'completed',
  total_kobo: 2_010_250,
  invoice_number: 'TEST-INV-000001',
  float_check: 'covered',
}

const byTable = (reads: Read[], table: string) => reads.filter((read) => read.table === table)

beforeEach(() => vi.clearAllMocks())

describe('listOrders', () => {
  it('reads one page of the side, newest first, with each order’s lines and masked buyer', async () => {
    const admin = await principal({ testOnly: true })
    const rpc = session({ admin_customers: { data: [customerRow(ids.user, 'e•••@example.com')] } })
    const reads = fakeService((read) => {
      if (read.table === 'admin_orders_v') return { data: [orderRow], count: 1 }
      if (read.table === 'order_items') {
        return {
          data: [
            { order_id: ids.order, item_type: 'register' },
            { order_id: ids.order, item_type: 'ssl' },
          ],
        }
      }
      return undefined
    })

    const list = await listOrders(admin, 'live', parseOrderListParams({}))

    const [orders] = byTable(reads, 'admin_orders_v')
    expect(orders?.select).toBe(
      'id, order_number, test_mode, created_at, paid_at, user_id, status, total_kobo, invoice_number, float_check',
    )
    expect(orders?.options).toEqual({ count: 'exact' })
    // A test admin is on the test side whatever was asked (D15).
    expect(filterOf(orders, 'eq', 'test_mode')).toBe(true)
    expect(orders?.filters).toContainEqual([
      'order',
      'created_at',
      { ascending: false, nullsFirst: false },
    ])
    expect(orders?.filters).toContainEqual(['range', 0, 24])
    const [lines] = byTable(reads, 'order_items')
    expect(filterOf(lines, 'in', 'order_id')).toEqual([ids.order])
    // The lines' side comes from their order (adminDb's parent rule).
    expect(lines?.select).toContain('admin_side:orders!inner(test_mode)')
    expect(rpc.rpc).toHaveBeenCalledWith('admin_customers', {
      p_test_mode: true,
      p_sort: 'joined',
      p_dir: 'desc',
      p_offset: 0,
      p_limit: 100,
      p_filter: {},
    })

    expect(list.total).toBe(1)
    expect(list.rows).toEqual([
      {
        id: ids.order,
        orderNumber: 'ND-001035',
        testMode: true,
        createdAt: orderRow.created_at,
        paidAt: orderRow.paid_at,
        userId: ids.user,
        customer: 'e•••@example.com',
        status: 'completed',
        totalKobo: 2_010_250,
        invoiceNumber: 'TEST-INV-000001',
        floatCheck: 'covered',
        lines: [
          { order_id: ids.order, item_type: 'register' },
          { order_id: ids.order, item_type: 'ssl' },
        ],
      },
    ])
  })

  it('never looks anything up for an email, or a search it cannot read', async () => {
    const admin = await principal()
    session()
    const reads = fakeService(() => undefined)
    for (const q of ['ada@example.com', 'hello there']) {
      expect(await listOrders(admin, 'live', parseOrderListParams({ q }))).toEqual({
        rows: [],
        total: 0,
        capped: false,
        stuckNote: null,
      })
    }
    expect(reads).toEqual([])
    expect(createClient).not.toHaveBeenCalled()
  })

  it('matches an order number, a payment reference and an invoice exactly', async () => {
    const admin = await principal()
    session({ admin_customers: { data: [] } })
    const reads = fakeService(() => ({ data: [], count: 0 }))
    await listOrders(admin, 'live', parseOrderListParams({ q: 'nd-1035' }))
    await listOrders(
      admin,
      'live',
      parseOrderListParams({ q: 'MDH-4FB8AFE8-1A3D-4E5F-9A7B-6C5D4E3F2A1B' }),
    )
    await listOrders(admin, 'live', parseOrderListParams({ q: 'inv-2' }))
    const [byNumber, byRef, byInvoice] = byTable(reads, 'admin_orders_v')
    expect(filterOf(byNumber, 'eq', 'order_number')).toBe('ND-001035')
    expect(filterOf(byRef, 'eq', 'tx_ref')).toBe('MDH-4fb8afe8-1a3d-4e5f-9a7b-6c5d4e3f2a1b')
    expect(filterOf(byInvoice, 'eq', 'invoice_number')).toBe('INV-000002')
    expect(filterOf(byNumber, 'eq', 'test_mode')).toBe(false)
  })

  it('finds a domain’s orders through their lines, and a kind’s within the dates', async () => {
    const admin = await principal()
    session({ admin_customers: { data: [] } })
    const reads = fakeService((read) => {
      if (read.table === 'order_items' && read.select?.startsWith('order_id, created_at')) {
        if (filterOf(read, 'eq', 'domain')) {
          return { data: [{ order_id: ids.order }, { order_id: ids.other }] }
        }
        return { data: [{ order_id: ids.other }, { order_id: ids.other }] }
      }
      if (read.table === 'admin_orders_v') return { data: [], count: 0 }
      return undefined
    })

    await listOrders(
      admin,
      'live',
      parseOrderListParams({
        q: 'GetPaid.com',
        kind: 'renew',
        from: '2026-09-01',
        to: '2026-09-30',
        status: 'paid',
      }),
    )

    const [byDomain, byKind] = byTable(reads, 'order_items')
    expect(filterOf(byDomain, 'eq', 'domain')).toBe('getpaid.com')
    expect(filterOf(byKind, 'eq', 'item_type')).toBe('renew')
    expect(filterOf(byKind, 'gte', 'created_at')).toBe('2026-09-01T00:00:00+01:00')
    expect(filterOf(byKind, 'lt', 'created_at')).toBe('2026-10-01T00:00:00+01:00')
    const [orders] = byTable(reads, 'admin_orders_v')
    // Only orders both sets name.
    expect(filterOf(orders, 'in', 'id')).toEqual([ids.other])
    expect(filterOf(orders, 'in', 'status')).toEqual(['paid'])
    expect(filterOf(orders, 'gte', 'created_at')).toBe('2026-09-01T00:00:00+01:00')
  })

  it('stops before the list when no order matches, and says when a scan was full', async () => {
    const admin = await principal()
    session()
    const full = Array.from({ length: 1000 }, (_, n) => ({
      order_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    }))
    const reads = fakeService((read) => {
      if (read.table === 'order_items' && filterOf(read, 'eq', 'domain')) return { data: [] }
      if (read.table === 'order_items') return { data: full }
      return { data: [], count: 0 }
    })
    const none = await listOrders(admin, 'live', parseOrderListParams({ q: 'nobody.ng' }))
    expect(none).toMatchObject({ rows: [], total: 0, capped: false })
    expect(byTable(reads, 'admin_orders_v')).toEqual([])

    await listOrders(admin, 'live', parseOrderListParams({ kind: 'transfer' }))
    const [orders] = byTable(reads, 'admin_orders_v')
    expect((filterOf(orders, 'in', 'id') as string[]).length).toBe(ORDER_ID_CAP)
  })

  it('reads the order of one line, for a ledger alert’s link', async () => {
    const admin = await principal()
    session({ admin_customers: { data: [] } })
    const reads = fakeService((read) =>
      read.table === 'order_items' ? { data: [{ order_id: ids.order }] } : { data: [], count: 0 },
    )
    await listOrders(admin, 'live', parseOrderListParams({ line: ids.line }))
    const [line] = byTable(reads, 'order_items')
    expect(filterOf(line, 'eq', 'id')).toBe(ids.line)
    expect(filterOf(byTable(reads, 'admin_orders_v')[0], 'in', 'id')).toEqual([ids.order])
  })

  it('lists stuck orders as SQL counts them, skipping a transfer still being released', async () => {
    const admin = await principal()
    session({ admin_customers: { data: [] } })
    const now = new Date('2026-10-03T12:00:00Z')
    const transferLine = '9a9b9c9d-0e0f-4a1b-8c2d-3e3f4a4b5c5d'
    const reads = fakeService((read) => {
      if (read.table === 'ops_settings') return { data: [{ stuck_order_minutes: 15 }] }
      if (read.table === 'admin_orders_v' && read.select === 'id, paid_at') {
        return { data: [{ id: ids.order }, { id: ids.other }] }
      }
      if (read.table === 'order_items') {
        return {
          data: [
            { id: ids.line, order_id: ids.order, item_type: 'register' },
            { id: transferLine, order_id: ids.other, item_type: 'transfer' },
          ],
        }
      }
      if (read.table === 'admin_domains_v') return { data: [{ order_item_id: transferLine }] }
      return { data: [], count: 0 }
    })

    const list = await listOrders(admin, 'live', parseOrderListParams({ stuck: '1' }), now)

    expect(list.stuckNote).toBeNull()
    const [candidates, page] = byTable(reads, 'admin_orders_v')
    expect(filterOf(candidates, 'in', 'status')).toEqual(['paid', 'provisioning'])
    expect(filterOf(candidates, 'lt', 'paid_at')).toBe('2026-10-03T11:45:00.000Z')
    const [unsettled] = byTable(reads, 'order_items')
    expect(filterOf(unsettled, 'in', 'status')).toEqual(['pending', 'provisioning'])
    expect(filterOf(byTable(reads, 'admin_domains_v')[0], 'eq', 'local_status')).toBe(
      'transfer_pending',
    )
    expect(filterOf(page, 'in', 'id')).toEqual([ids.order])
  })

  it('tells a test admin the stuck filter has no threshold, without reading settings', async () => {
    const admin = await principal({ testOnly: true })
    session()
    const reads = fakeService(() => ({ data: [] }))
    const list = await listOrders(admin, 'test', parseOrderListParams({ stuck: '1' }))
    expect(list.stuckNote).toBe('test_admin')
    expect(byTable(reads, 'ops_settings')).toEqual([])
    const [candidates] = byTable(reads, 'admin_orders_v')
    expect(filterOf(candidates, 'lt', 'paid_at')).toBeUndefined()
  })

  it('counts the list when a page is past its end, rather than failing', async () => {
    const admin = await principal()
    session()
    const reads = fakeService((read) => {
      if (read.options?.head) return { data: null, count: 30 }
      return { error: { message: 'Requested range not satisfiable', code: 'PGRST103' } }
    })
    const list = await listOrders(admin, 'live', parseOrderListParams({ page: '9' }))
    expect(list).toMatchObject({ rows: [], total: 30 })
    const [, count] = byTable(reads, 'admin_orders_v')
    expect(count?.select).toBe('id')
    expect(count?.options).toEqual({ count: 'exact', head: true })
  })

  it('throws a read error, naming what failed but not the search', async () => {
    const admin = await principal()
    session()
    fakeService(() => ({ error: { message: 'boom', code: '57014' } }))
    await expect(
      listOrders(admin, 'live', parseOrderListParams({ q: 'secret-domain.com' })),
    ).rejects.toThrow(new OrdersReadError('lines by domain'))
  })
})

describe('maskedCustomers', () => {
  it('pages through customers until every buyer is found', async () => {
    const other = '9f9f9f9f-0e0f-4a1b-8c2d-3e3f4a4b5c5d'
    const filler = Array.from({ length: 100 }, (_, n) =>
      customerRow(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, 'x•••@example.com'),
    )
    const rpc = session({
      admin_customers: [
        { data: filler },
        { data: [customerRow(ids.user, 'a•••@gmail.com'), customerRow(other, 'b•••@x.ng')] },
      ],
    })
    const found = await maskedCustomers('live', [ids.user, null, ids.user])
    expect(found.get(ids.user)).toBe('a•••@gmail.com')
    expect(rpc.rpc).toHaveBeenCalledTimes(2)
    expect(rpc.rpc).toHaveBeenLastCalledWith(
      'admin_customers',
      expect.objectContaining({ p_offset: 100, p_test_mode: false }),
    )
  })

  it('asks nothing for no buyers, and gives up quietly when SQL refuses', async () => {
    const rpc = session({ admin_customers: { error: { message: 'admin:test_admin' } } })
    expect((await maskedCustomers('live', [null])).size).toBe(0)
    expect(rpc.rpc).not.toHaveBeenCalled()
    expect((await maskedCustomers('live', [ids.user])).size).toBe(0)
    expect(rpc.rpc).toHaveBeenCalledTimes(1)
  })
})

describe('getOrderFunnel', () => {
  it('asks SQL for the side and range, and reads every stage', async () => {
    const rpc = session({
      admin_funnel: {
        data: {
          cartAdds: 12,
          cartAddsSince: '2026-10-03',
          created: '5',
          paid: 4,
          completed: 3,
          partial: 0,
          failed: 1,
          cancelled: 0,
          awaiting: 1,
          inFlight: 0,
          medianSecsToPay: 95,
          medianSecsToSettle: null,
        },
      },
    })
    const funnel = await getOrderFunnel('test', { from: '2026-09-04', to: '2026-10-03' })
    expect(rpc.rpc).toHaveBeenCalledWith('admin_funnel', {
      p_test_mode: true,
      p_from: '2026-09-04',
      p_to: '2026-10-03',
    })
    expect(funnel).toMatchObject({ cartAdds: 12, created: 5, medianSecsToPay: 95 })
    expect(funnel?.medianSecsToSettle).toBeNull()
  })

  it('is null when SQL refuses or answers something else', async () => {
    session({ admin_funnel: { error: { message: 'admin:bad_range', code: '22023' } } })
    expect(await getOrderFunnel('live', { from: '2026-10-03', to: '2026-10-03' })).toBeNull()
    session({ admin_funnel: { data: 'nope' } })
    expect(await getOrderFunnel('live', { from: '2026-10-03', to: '2026-10-03' })).toBeNull()
  })
})

describe('getOrderDetail', () => {
  const fullOrder = {
    ...orderRow,
    updated_at: '2026-10-02T09:05:00Z',
    payment_checked_at: '2026-10-02T09:01:00Z',
    subtotal_kobo: 1_870_000,
    vat_kobo: 140_250,
    vat_pct: 7.5,
    tx_ref: 'MDH-4fb8afe8-1a3d-4e5f-9a7b-6c5d4e3f2a1b',
    nameservers: null,
  }

  function detailDb(
    overrides: Partial<Record<string, ReturnType<Parameters<typeof fakeService>[0]>>> = {},
  ) {
    return fakeService((read) => {
      if (read.table in overrides) return overrides[read.table]
      switch (read.table) {
        case 'admin_orders_v':
          return { data: [fullOrder] }
        case 'order_items':
          return {
            data: [
              {
                id: ids.line,
                item_type: 'register',
                domain: 'getpaid.com',
                period_years: 1,
                price_kobo: 1_870_000,
                renewal_kobo: 1_870_000,
                renewal_years: 1,
                status: 'completed',
                failure_code: null,
                auto_renew: true,
                privacy: false,
                domain_id: null,
                created_at: '2026-10-02T09:00:00Z',
              },
            ],
          }
        case 'order_item_costs':
          return {
            data: [
              {
                order_item_id: ids.line,
                supplier_cost_cents: 1131,
                icann_fee_cents: 20,
                recorded_at: '2026-10-02T09:00:00Z',
              },
            ],
          }
        case 'jobs':
          return {
            data: [
              {
                id: ids.job,
                kind: 'register_domain',
                status: 'succeeded',
                attempts: 1,
                order_item_id: ids.line,
                created_at: '2026-10-02T09:01:00Z',
                finished_at: '2026-10-02T09:02:00Z',
                last_error_code: null,
              },
            ],
          }
        case 'admin_domains_v':
          return { data: [{ id: ids.domain, domain_name: 'getpaid.com', order_item_id: ids.line }] }
        case 'admin_payments_v':
          return {
            data: [
              {
                id: ids.payment,
                provider_reference: '9001',
                amount_kobo: 2_010_250,
                charged_kobo: 2_010_250,
                fee_kobo: 28_144,
                absorbed: true,
                status: 'successful',
                method: 'card',
                created_at: '2026-10-02T09:01:00Z',
              },
            ],
          }
        case 'refunds':
          return { data: [] }
        case 'payment_incidents':
          return { data: [] }
        case 'supplier_calls':
          return {
            data: [
              {
                id: 7,
                created_at: '2026-10-02T09:01:30Z',
                operation: 'RegisterWithContactInfo',
                outcome: 'ok',
                http_status: 200,
                duration_ms: 2400,
                error_code: null,
                job_id: ids.job,
              },
            ],
          }
        case 'domain_events':
          return {
            data: [
              {
                id: 11,
                domain_id: ids.domain,
                event_type: 'registered',
                actor_type: 'system',
                created_at: '2026-10-02T09:02:00Z',
              },
            ],
          }
        default:
          return undefined
      }
    })
  }

  it('reads nothing for an id that is not a uuid', async () => {
    const admin = await principal()
    const reads = fakeService(() => undefined)
    expect(await getOrderDetail(admin, 'live', 'ND-001035')).toBeNull()
    expect(reads).toEqual([])
  })

  it('is null for an order not on this side', async () => {
    const admin = await principal()
    session()
    detailDb({ admin_orders_v: { data: [] } })
    expect(await getOrderDetail(admin, 'live', ids.order)).toBeNull()
  })

  it('reads every part of the order from the masked views and the side’s rows', async () => {
    const admin = await principal()
    session({ admin_customers: { data: [customerRow(ids.user, 'e•••@example.com')] } })
    const reads = detailDb()

    const detail = await getOrderDetail(admin, 'test', ids.order.toUpperCase())
    if (!detail) throw new Error('no detail')

    expect(filterOf(byTable(reads, 'admin_orders_v')[0], 'eq', 'id')).toBe(ids.order)
    expect(detail.order).toMatchObject({
      orderNumber: 'ND-001035',
      customer: 'e•••@example.com',
      vatPct: 7.5,
      totalKobo: 2_010_250,
    })
    expect(detail.lines).toEqual({
      ok: true,
      data: [
        expect.objectContaining({
          id: ids.line,
          domain: 'getpaid.com',
          domainId: ids.domain,
          cost: expect.objectContaining({ supplier_cost_cents: 1131, icann_fee_cents: 20 }),
          jobIds: [ids.job],
        }),
      ],
    })
    // The cost's side comes through its line and order.
    expect(byTable(reads, 'order_item_costs')[0]?.select).toContain(
      'admin_side:order_items!inner(orders!inner(test_mode))',
    )
    expect(detail.payments).toEqual({
      ok: true,
      data: [expect.objectContaining({ feeKobo: 28_144, absorbed: true })],
    })
    expect(detail.trace).toEqual({
      ok: true,
      data: {
        jobs: [expect.objectContaining({ id: ids.job, kind: 'register_domain' })],
        calls: [
          expect.objectContaining({ operation: 'RegisterWithContactInfo', durationMs: 2400 }),
        ],
      },
    })
    // Supplier calls on the test side are the sandbox's.
    expect(filterOf(byTable(reads, 'supplier_calls')[0], 'eq', 'environment')).toBe('ote')
    expect(filterOf(byTable(reads, 'supplier_calls')[0], 'in', 'job_id')).toEqual([ids.job])
    const events = byTable(reads, 'domain_events')[0]
    expect(filterOf(events, 'in', 'domain_id')).toEqual([ids.domain])
    expect(filterOf(events, 'gte', 'created_at')).toBe(fullOrder.created_at)
    expect(detail.activity.ok && detail.activity.data.domains.get(ids.domain)).toBe('getpaid.com')
    expect(detail.refunds).toEqual({ ok: true, data: [] })
    expect(detail.incidents).toEqual({ ok: true, data: [] })
  })

  it('leaves the other parts standing when one read fails', async () => {
    const admin = await principal()
    session({ admin_customers: { data: [] } })
    detailDb({ admin_payments_v: { error: { message: 'boom', code: '57014' } } })
    const detail = await getOrderDetail(admin, 'live', ids.order)
    expect(detail?.payments).toEqual({ ok: false })
    expect(detail?.lines.ok).toBe(true)
    expect(detail?.trace.ok).toBe(true)
    expect(detail?.order.customer).toBeUndefined()
  })

  it('fails the parts that need the lines when the lines cannot be read', async () => {
    const admin = await principal()
    session({ admin_customers: { data: [] } })
    detailDb({ order_items: { error: { message: 'boom' } } })
    const detail = await getOrderDetail(admin, 'live', ids.order)
    expect(detail?.lines).toEqual({ ok: false })
    expect(detail?.trace).toEqual({ ok: false })
    expect(detail?.activity).toEqual({ ok: false })
    expect(detail?.payments.ok).toBe(true)
  })

  it('throws when the order itself cannot be read', async () => {
    const admin = await principal()
    session()
    detailDb({ admin_orders_v: { error: { message: 'boom' } } })
    await expect(getOrderDetail(admin, 'live', ids.order)).rejects.toBeInstanceOf(OrdersReadError)
  })
})
