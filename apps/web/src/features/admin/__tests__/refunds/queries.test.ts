import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseListParams } from '@/features/admin/lib/list-params'
import { parseIncidentParams, REFUND_LIST } from '@/features/admin/lib/refunds-rules'
import {
  countOpenIncidents,
  getRefund,
  getRefundStats,
  listIncidents,
  listRefunds,
} from '@/features/admin/queries/refunds'
import { type AdminPrincipal, adminWhoami } from '@/features/admin/queries/session'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * The refunds pages' reads (ADMIN-SPEC §5.2 B3), against a recorded service
 * client: what each asks for — through adminDb, which adds the side — and
 * what it makes of the answer, a failure included.
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

type Answer = { data?: unknown; error?: { code?: string; message?: string } | null; count?: number }
type Call = [string, ...unknown[]]

const METHODS = [
  'select',
  'eq',
  'in',
  'gte',
  'lt',
  'is',
  'not',
  'order',
  'range',
  'limit',
  'maybeSingle',
]

/** A service client whose tables answer in turn, recording every call as `table.method`. */
function service(answers: Record<string, Answer[]>) {
  const calls: Call[] = []
  const queues = new Map(Object.entries(answers).map(([table, list]) => [table, [...list]]))
  const from = (table: string) => {
    calls.push(['from', table])
    const answer = queues.get(table)?.shift() ?? { data: [], error: null, count: 0 }
    const builder: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: PostgREST's builder is awaited; this stands in for it
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, count: null, ...answer }).then(resolve, reject),
    }
    for (const method of METHODS) {
      builder[method] = (...args: unknown[]) => {
        calls.push([`${table}.${method}`, ...args])
        return builder
      }
    }
    return builder
  }
  vi.mocked(createServiceClient).mockReturnValue({ from } as never)
  return calls
}

const callsOf = (calls: Call[], prefix: string) => calls.filter(([name]) => name.startsWith(prefix))

async function principal(): Promise<AdminPrincipal> {
  const session = sessionClient({ rpc: { admin_whoami: { data: whoami({ role: 'operator' }) } } })
  return adminWhoami(session.client as never, null)
}

const REFUND = '6f1d2c3b-4a59-4687-9a1b-2c3d4e5f6a7b'
const ORDER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LINE = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'

beforeEach(() => vi.clearAllMocks())

describe('getRefundStats', () => {
  const stats = {
    byReasonStatus: [{ reason: 'overpayment', status: 'held', count: 2, amountKobo: 5000 }],
    openOldestAt: '2026-10-01T09:00:00Z',
    medianHoursToComplete: 1.5,
    sent24hKobo: '120000',
    limits: { singleKobo: 100_000_000, dailyKobo: 500_000_000, delayMinutes: 10 },
  }

  it('asks SQL as the admin, for the side', async () => {
    const session = sessionClient({ rpc: { admin_refund_stats: { data: stats } } })
    vi.mocked(createClient).mockResolvedValue(session.client as never)
    expect(await getRefundStats('test')).toEqual({ ...stats, sent24hKobo: 120_000 })
    expect(session.rpc).toHaveBeenCalledWith('admin_refund_stats', { p_test_mode: true })
  })

  it('is null when refused or unreadable: limits are never guessed', async () => {
    const refused = sessionClient({
      rpc: { admin_refund_stats: { error: { message: 'admin:test_admin' } } },
    })
    vi.mocked(createClient).mockResolvedValue(refused.client as never)
    expect(await getRefundStats('live')).toBeNull()
    const shapeless = sessionClient({
      rpc: { admin_refund_stats: { data: { ...stats, limits: null } } },
    })
    vi.mocked(createClient).mockResolvedValue(shapeless.client as never)
    expect(await getRefundStats('live')).toBeNull()
  })
})

describe('listRefunds', () => {
  const row = {
    id: REFUND,
    created_at: '2026-10-02T10:00:00Z',
    updated_at: '2026-10-02T11:00:00Z',
    order_id: ORDER,
    reason: 'registration_failed',
    status: 'held',
    amount_kobo: 107_500,
    last_error_code: 'OVER_SINGLE_LIMIT',
    attempts: 0,
    test_mode: true,
  }

  it('filters, sorts and pages by the URL, on the side, with order numbers', async () => {
    const calls = service({
      refunds: [{ data: [row], count: 31 }],
      admin_orders_v: [{ data: [{ id: ORDER, order_number: 'ND-001234' }] }],
    })
    const params = parseListParams(
      {
        status: 'held,failed',
        sort: 'amount',
        dir: 'asc',
        page: '2',
        from: '2026-10-01',
        to: '2026-10-02',
      },
      REFUND_LIST,
    )
    const result = await listRefunds(await principal(), 'test', {
      ...params,
      reasons: ['registration_failed'],
      orderNumber: null,
    })
    expect(result).toEqual({
      ok: true,
      total: 31,
      rows: [
        {
          id: REFUND,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          orderId: ORDER,
          orderNumber: 'ND-001234',
          reason: 'registration_failed',
          status: 'held',
          amountKobo: 107_500,
          lastErrorCode: 'OVER_SINGLE_LIMIT',
          attempts: 0,
          testMode: true,
        },
      ],
    })
    expect(callsOf(calls, 'refunds.')).toEqual([
      [
        'refunds.select',
        'id, created_at, updated_at, order_id, reason, status, amount_kobo, last_error_code, attempts, test_mode',
        { count: 'exact' },
      ],
      ['refunds.eq', 'test_mode', true],
      ['refunds.in', 'status', ['held', 'failed']],
      ['refunds.in', 'reason', ['registration_failed']],
      ['refunds.gte', 'created_at', '2026-10-01T00:00:00+01:00'],
      ['refunds.lt', 'created_at', '2026-10-03T00:00:00+01:00'],
      ['refunds.order', 'amount_kobo', { ascending: true }],
      ['refunds.order', 'id', { ascending: true }],
      ['refunds.range', 25, 49],
    ])
    expect(callsOf(calls, 'admin_orders_v.in')).toEqual([['admin_orders_v.in', 'id', [ORDER]]])
  })

  it('finds an order number first, and shows nothing when no order has it', async () => {
    const calls = service({ admin_orders_v: [{ data: [] }] })
    const params = parseListParams({}, REFUND_LIST)
    expect(
      await listRefunds(await principal(), 'live', {
        ...params,
        reasons: [],
        orderNumber: 'ND-000001',
      }),
    ).toEqual({ ok: true, rows: [], total: 0 })
    expect(callsOf(calls, 'admin_orders_v.eq')).toContainEqual([
      'admin_orders_v.eq',
      'order_number',
      'ND-000001',
    ])
    expect(callsOf(calls, 'refunds.')).toEqual([])
  })

  it("narrows to the order's refunds when it is found", async () => {
    const calls = service({
      admin_orders_v: [{ data: [{ id: ORDER }] }, { data: [] }],
      refunds: [{ data: [row], count: 1 }],
    })
    const params = parseListParams({}, REFUND_LIST)
    const result = await listRefunds(await principal(), 'live', {
      ...params,
      reasons: [],
      orderNumber: 'ND-001234',
    })
    expect(callsOf(calls, 'refunds.eq')).toContainEqual(['refunds.eq', 'order_id', ORDER])
    expect(result.ok && result.rows[0]?.orderNumber).toBeNull()
  })

  it('fails in one piece when a read fails', async () => {
    service({ admin_orders_v: [{ error: { code: '57014' } }] })
    const params = parseListParams({}, REFUND_LIST)
    expect(
      await listRefunds(await principal(), 'live', {
        ...params,
        reasons: [],
        orderNumber: 'ND-000001',
      }),
    ).toEqual({ ok: false })
    service({ refunds: [{ error: { code: '57014' } }] })
    expect(
      await listRefunds(await principal(), 'live', { ...params, reasons: [], orderNumber: null }),
    ).toEqual({ ok: false })
  })
})

describe('getRefund', () => {
  const detail = {
    id: REFUND,
    created_at: '2026-10-02T10:00:00Z',
    updated_at: '2026-10-02T11:00:00Z',
    order_id: ORDER,
    order_item_id: LINE,
    payment_id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    reason: 'registration_failed',
    status: 'held',
    amount_kobo: 107_500,
    last_error_code: 'OVER_SINGLE_LIMIT',
    attempts: 0,
    run_after: '2026-10-02T10:10:00Z',
    approved_at: null,
    approved_by: null,
    completed_at: null,
    submitted_at: null,
    provider_called_at: null,
    provider_refund_id: null,
    provider_status: null,
    failed_provider_refund_ids: null,
    test_mode: true,
  }

  it('reads nothing for an id that is not one', async () => {
    const calls = service({})
    expect(await getRefund(await principal(), 'test', 'nope')).toEqual({ ok: true, refund: null })
    expect(calls).toEqual([])
  })

  it('is null for a refund not on this side', async () => {
    service({ refunds: [{ data: null }] })
    expect(await getRefund(await principal(), 'live', REFUND)).toEqual({ ok: true, refund: null })
  })

  it('brings its order, its line and its events, newest first', async () => {
    const calls = service({
      refunds: [{ data: detail }],
      admin_orders_v: [
        {
          data: {
            id: ORDER,
            order_number: 'ND-001234',
            status: 'partially_failed',
            total_kobo: 215_000,
            paid_at: '2026-10-02T09:59:00Z',
            tx_ref: 'MDH-abc',
          },
        },
      ],
      order_items: [
        {
          data: {
            id: LINE,
            domain: 'example.com',
            item_type: 'register',
            status: 'failed',
            price_kobo: 100_000,
            period_years: 1,
          },
        },
      ],
      refund_events: [
        {
          data: [
            {
              id: 2,
              created_at: '2026-10-02T10:00:01Z',
              event: 'held',
              actor: 'e2e',
              detail: { why: 'over_single_limit' },
            },
            {
              id: 1,
              created_at: '2026-10-02T10:00:00Z',
              event: 'queued',
              actor: 'system',
              detail: null,
            },
          ],
        },
      ],
    })
    const result = await getRefund(await principal(), 'test', REFUND.toUpperCase())
    if (!result.ok || !result.refund) throw new Error('no refund')
    expect(result.refund).toMatchObject({
      id: REFUND,
      amountKobo: 107_500,
      failedProviderRefundIds: [],
      order: { id: ORDER, orderNumber: 'ND-001234', totalKobo: 215_000, txRef: 'MDH-abc' },
      line: { domain: 'example.com', itemType: 'register', status: 'failed', priceKobo: 100_000 },
    })
    expect(result.refund.events).toEqual([
      {
        id: 2,
        at: '2026-10-02T10:00:01Z',
        event: 'held',
        actor: 'e2e',
        detail: { why: 'over_single_limit' },
      },
      { id: 1, at: '2026-10-02T10:00:00Z', event: 'queued', actor: 'system', detail: {} },
    ])
    expect(callsOf(calls, 'refunds.eq')).toEqual([
      ['refunds.eq', 'test_mode', true],
      ['refunds.eq', 'id', REFUND],
    ])
    expect(callsOf(calls, 'refund_events.eq')).toEqual([
      ['refund_events.eq', 'admin_side.test_mode', true],
      ['refund_events.eq', 'refund_id', REFUND],
    ])
  })

  it('has no line for a charge refund, and fails when a part fails', async () => {
    service({
      refunds: [{ data: { ...detail, order_item_id: null } }],
      admin_orders_v: [{ data: null }],
    })
    const charge = await getRefund(await principal(), 'test', REFUND)
    expect(charge.ok && charge.refund?.line).toBeNull()
    expect(charge.ok && charge.refund?.order.orderNumber).toBeNull()

    service({ refunds: [{ data: detail }], refund_events: [{ error: { code: '500' } }] })
    expect(await getRefund(await principal(), 'test', REFUND)).toEqual({ ok: false })
    service({ refunds: [{ error: { code: '500' } }] })
    expect(await getRefund(await principal(), 'test', REFUND)).toEqual({ ok: false })
  })
})

describe('listIncidents', () => {
  const incident = {
    id: 42,
    created_at: '2026-10-02T10:00:00Z',
    kind: 'unrecorded_payment',
    order_id: ORDER,
    provider_reference: '456',
    detail: { amount_kobo: 107_500 },
    resolved_at: null,
    resolved_by: null,
    test_mode: true,
  }

  it('lists unresolved incidents by default, with order numbers and their completed refunds', async () => {
    const calls = service({
      payment_incidents: [{ data: [incident, { ...incident, id: 43, order_id: null }], count: 2 }],
      admin_orders_v: [{ data: [{ id: ORDER, order_number: 'ND-001234' }] }],
      refunds: [
        { data: [{ id: REFUND, order_id: ORDER, amount_kobo: 107_500, completed_at: null }] },
      ],
    })
    const result = await listIncidents(await principal(), 'test', parseIncidentParams({}))
    if (!result.ok) throw new Error('failed')
    expect(result.total).toBe(2)
    expect(result.rows[0]).toMatchObject({
      id: 42,
      orderNumber: 'ND-001234',
      detail: { amount_kobo: 107_500 },
      completedRefunds: [{ id: REFUND, amountKobo: 107_500, completedAt: null }],
    })
    expect(result.rows[1]).toMatchObject({ id: 43, orderNumber: null, completedRefunds: [] })
    expect(callsOf(calls, 'payment_incidents.is')).toEqual([
      ['payment_incidents.is', 'resolved_at', null],
    ])
    expect(callsOf(calls, 'refunds.eq')).toContainEqual(['refunds.eq', 'status', 'completed'])
  })

  it('shows resolved ones on request, of the kinds asked for', async () => {
    const calls = service({ payment_incidents: [{ data: [], count: 0 }] })
    const result = await listIncidents(
      await principal(),
      'live',
      parseIncidentParams({ state: 'resolved', kind: 'underpayment', dir: 'asc' }),
    )
    expect(result).toEqual({ ok: true, rows: [], total: 0 })
    expect(callsOf(calls, 'payment_incidents.not')).toEqual([
      ['payment_incidents.not', 'resolved_at', 'is', null],
    ])
    expect(callsOf(calls, 'payment_incidents.in')).toEqual([
      ['payment_incidents.in', 'kind', ['underpayment']],
    ])
    expect(callsOf(calls, 'refunds.')).toEqual([])
  })

  it('shows one incident by its number, resolved or not', async () => {
    const calls = service({
      payment_incidents: [{ data: [{ ...incident, resolved_at: '2026-10-03T09:00:00Z' }] }],
      admin_orders_v: [{ data: [] }],
      refunds: [{ data: [] }],
    })
    const result = await listIncidents(await principal(), 'live', parseIncidentParams({ id: '42' }))
    if (!result.ok) throw new Error('failed')
    expect(result.rows.map((row) => row.id)).toEqual([42])
    expect(callsOf(calls, 'payment_incidents.eq')).toContainEqual([
      'payment_incidents.eq',
      'id',
      42,
    ])
    expect(callsOf(calls, 'payment_incidents.is')).toEqual([])
    expect(callsOf(calls, 'payment_incidents.not')).toEqual([])
  })

  it('fails when the list or its refunds cannot be read', async () => {
    service({ payment_incidents: [{ error: { code: '500' } }] })
    expect(await listIncidents(await principal(), 'live', parseIncidentParams({}))).toEqual({
      ok: false,
    })
    service({
      payment_incidents: [{ data: [incident], count: 1 }],
      refunds: [{ error: { code: '500' } }],
    })
    expect(await listIncidents(await principal(), 'live', parseIncidentParams({}))).toEqual({
      ok: false,
    })
  })
})

describe('countOpenIncidents', () => {
  it('counts unresolved incidents on the side, or says it cannot', async () => {
    const calls = service({ payment_incidents: [{ count: 3 }] })
    expect(await countOpenIncidents(await principal(), 'test')).toBe(3)
    expect(callsOf(calls, 'payment_incidents.select')).toEqual([
      ['payment_incidents.select', 'id', { count: 'exact', head: true }],
    ])
    service({ payment_incidents: [{ error: { code: '500' } }] })
    expect(await countOpenIncidents(await principal(), 'test')).toBeNull()
  })
})
