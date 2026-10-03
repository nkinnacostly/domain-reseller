import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCallsSearch } from '@/features/admin/lib/supplier-calls'
import { parseLedgerSearch } from '@/features/admin/lib/supplier-ledger'
import { adminWhoami } from '@/features/admin/queries/session'
import {
  getBalanceCloses,
  getCallSummary,
  getCalls,
  getCostingRate,
  getLedgerChain,
  getLedgerDaily,
  getLedgerPage,
  getLedgerRevisions,
  getSupplierFloat,
  getSyncHeartbeats,
  getTopupHistory,
} from '@/features/admin/queries/supplier'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { floatAnswer, TRACE } from './fixtures'
import { fakeService } from './service'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
// React's cache() remembers one answer outside a render; each test asks afresh.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}))

function session(rpc: NonNullable<Parameters<typeof sessionClient>[0]>['rpc'] = {}) {
  const client = sessionClient({ rpc })
  vi.mocked(createClient).mockResolvedValue(client.client as never)
  return client
}

async function principal(overrides: Record<string, unknown> = {}) {
  const client = sessionClient({ rpc: { admin_whoami: { data: whoami(overrides) } } })
  return adminWhoami(client.client as never, null)
}

const ROW = {
  trace_id: TRACE,
  occurred_at: '2026-10-01T09:00:00+00:00',
  type: 2,
  status: 1,
  charge_type: 1,
  product_type: 1,
  description: 'example.com',
  period: 1,
  old_balance_cents: 4338,
  balance_cents: 3207,
  delta_cents: -1131,
  match_state: 'matched',
  match_call_id: 12,
  match_operation: 'RegisterWithContactInfo',
  match_order_item_id: '0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
  matched_at: '2026-10-01T09:05:00+00:00',
}

beforeEach(() => vi.clearAllMocks())

describe('the SQL reads, as the admin', () => {
  it('reads admin_float for one side', async () => {
    const client = session({ admin_float: { data: floatAnswer() } })
    const float = await getSupplierFloat('test')
    expect(client.rpc).toHaveBeenCalledWith('admin_float', { p_test_mode: true })
    expect(float?.topups).toHaveLength(2)
  })

  it('is null when SQL refuses, or answers a shape it did not promise', async () => {
    session({ admin_float: { error: { message: 'admin:test_admin', code: '42501' } } })
    expect(await getSupplierFloat('live')).toBeNull()
    session({ admin_float: { data: { balanceCents: 'lots' } } })
    expect(await getSupplierFloat('live')).toBeNull()
  })

  it('reads the mirror per Lagos day over a range', async () => {
    const client = session({
      admin_ledger_daily: {
        data: [{ day: '2026-10-02', debit_cents: 1131, credit_cents: 0, close_cents: 3207 }],
      },
    })
    expect(await getLedgerDaily('live', '2026-07-06', '2026-10-03')).toEqual([
      { day: '2026-10-02', debitCents: 1131, creditCents: 0, closeCents: 3207 },
    ])
    expect(client.rpc).toHaveBeenCalledWith('admin_ledger_daily', {
      p_test_mode: false,
      p_from: '2026-07-06',
      p_to: '2026-10-03',
    })
    session({ admin_ledger_daily: { error: { message: 'admin:bad_range' } } })
    expect(await getLedgerDaily('live', '2026-10-03', '2026-07-06')).toBeNull()
    session({ admin_ledger_daily: { data: [{ day: 'x' }] } })
    expect(await getLedgerDaily('live', '2026-07-06', '2026-10-03')).toBeNull()
  })

  it('summarises calls by operation, busiest first', async () => {
    const client = session({
      admin_provisioning: {
        data: {
          jobs: [],
          lines: [],
          ssl: [],
          calls: [
            { operation: 'GetDetails', outcome: 'ok', count: 2, p50Ms: 400, p95Ms: 900 },
            { operation: 'GetList', outcome: 'ok', count: 219, p50Ms: 800, p95Ms: 2100 },
          ],
        },
      },
    })
    const rows = await getCallSummary('live', '2026-09-27', '2026-10-03')
    expect(rows?.map((row) => row.operation)).toEqual(['GetList', 'GetDetails'])
    expect(client.rpc).toHaveBeenCalledWith('admin_provisioning', {
      p_test_mode: false,
      p_from: '2026-09-27',
      p_to: '2026-10-03',
    })
    session({ admin_provisioning: { data: { calls: 'none' } } })
    expect(await getCallSummary('live', '2026-09-27', '2026-10-03')).toBeNull()
    session({ admin_provisioning: { error: { message: 'boom' } } })
    expect(await getCallSummary('live', '2026-09-27', '2026-10-03')).toBeNull()
  })
})

describe('the row reads, through adminDb on the side', () => {
  it('reads one ledger page, filtered as the URL says, with its total', async () => {
    const calls = fakeService({
      supplier_ledger_entries: { data: [ROW, { trace_id: 1 }], count: 7 },
    })
    const params = parseLedgerSearch({
      status: 'unexplained,matched',
      trace: TRACE.toUpperCase(),
      from: '2026-10-01',
      to: '2026-10-02',
      sort: 'change',
      dir: 'asc',
      page: '2',
      per: '25',
    })
    const page = await getLedgerPage(await principal(), 'live', params)
    expect(page?.total).toBe(7)
    expect(page?.rows).toEqual([
      expect.objectContaining({
        traceId: TRACE,
        deltaCents: -1131,
        matchOperation: 'RegisterWithContactInfo',
        matchCallId: 12,
      }),
    ])
    expect(calls).toEqual([
      ['from', 'supplier_ledger_entries'],
      [
        'select',
        expect.stringContaining('trace_id, occurred_at, type, status'),
        { count: 'exact' },
      ],
      ['eq', 'test_mode', false],
      ['in', 'match_state', ['unexplained', 'matched']],
      ['eq', 'trace_id', TRACE],
      ['gte', 'occurred_at', '2026-09-30T23:00:00.000Z'],
      ['lt', 'occurred_at', '2026-10-02T23:00:00.000Z'],
      ['order', 'delta_cents', { ascending: true }],
      ['order', 'trace_id', { ascending: true }],
      ['range', 25, 49],
    ])
  })

  it('keeps a test administrator on the test side, whatever is asked', async () => {
    const calls = fakeService()
    await getLedgerPage(await principal({ testOnly: true }), 'live', parseLedgerSearch({}))
    expect(calls).toContainEqual(['eq', 'test_mode', true])
  })

  it('is null when a read fails or is refused', async () => {
    fakeService({ supplier_ledger_entries: { error: { code: '57014' } } })
    expect(await getLedgerPage(await principal(), 'live', parseLedgerSearch({}))).toBeNull()
    fakeService()
    const forged = { ...whoami() } as never
    expect(await getLedgerPage(forged, 'live', parseLedgerSearch({}))).toBeNull()
    expect(await getLedgerChain(forged, 'live')).toBeNull()
    expect(await getLedgerRevisions(forged, 'live', [TRACE])).toBeNull()
    expect(await getTopupHistory(forged, 'live')).toBeNull()
    expect(await getCostingRate(forged)).toBeNull()
    expect(await getBalanceCloses(forged, 'live', '2026-07-06')).toBeNull()
    expect(await getCalls(forged, 'live', parseCallsSearch({}))).toBeNull()
  })

  it('groups the page’s revisions by trace, newest first, and asks nothing for no rows', async () => {
    const calls = fakeService({
      supplier_ledger_revisions: {
        data: [
          { id: 2, trace_id: TRACE, seen_at: '2026-10-02T09:00:00Z', changes: {}, applied: true },
          { id: 1, trace_id: TRACE, seen_at: '2026-10-01T09:00:00Z', changes: {}, applied: false },
          { id: 3, trace_id: null, seen_at: 'x', changes: {}, applied: false },
        ],
      },
    })
    const admin = await principal()
    const byTrace = await getLedgerRevisions(admin, 'test', [TRACE])
    expect(byTrace?.get(TRACE)?.map((r) => [r.id, r.applied])).toEqual([
      [2, true],
      [1, false],
    ])
    expect(calls).toContainEqual(['in', 'trace_id', [TRACE]])
    expect(calls).toContainEqual(['eq', 'test_mode', true])
    const before = calls.length
    expect((await getLedgerRevisions(admin, 'test', []))?.size).toBe(0)
    expect(calls).toHaveLength(before)
    fakeService({ supplier_ledger_revisions: { error: { code: 'x' } } })
    expect(await getLedgerRevisions(admin, 'test', [TRACE])).toBeNull()
  })

  it('reads the latest balances for the chain, newest first', async () => {
    const calls = fakeService({
      supplier_ledger_entries: {
        data: [
          {
            trace_id: TRACE,
            occurred_at: ROW.occurred_at,
            description: 'example.com',
            old_balance_cents: 4338,
            balance_cents: 3207,
          },
          {
            trace_id: 'x',
            occurred_at: 'y',
            description: null,
            old_balance_cents: 1.5,
            balance_cents: 2,
          },
        ],
      },
    })
    expect(await getLedgerChain(await principal(), 'live')).toEqual([
      {
        traceId: TRACE,
        occurredAt: ROW.occurred_at,
        description: 'example.com',
        oldBalanceCents: 4338,
        balanceCents: 3207,
      },
    ])
    expect(calls).toContainEqual(['order', 'occurred_at', { ascending: false }])
    expect(calls).toContainEqual(['limit', 200])
    fakeService({ supplier_ledger_entries: { error: { code: 'x' } } })
    expect(await getLedgerChain(await principal(), 'live')).toBeNull()
  })

  it('reads the daily closes from the rollup', async () => {
    const calls = fakeService({
      metrics_daily: {
        data: [
          { day: '2026-10-01', value: 738 },
          { day: '2026-10-02', value: 1.5 },
        ],
      },
    })
    expect(await getBalanceCloses(await principal(), 'live', '2026-07-06')).toEqual([
      { day: '2026-10-01', closeCents: 738 },
    ])
    expect(calls).toContainEqual(['eq', 'metric', 'balance_close_cents'])
    expect(calls).toContainEqual(['gte', 'day', '2026-07-06'])
    fakeService({ metrics_daily: { error: { code: 'x' } } })
    expect(await getBalanceCloses(await principal(), 'live', '2026-07-06')).toBeNull()
  })

  it('reads every top-up record on the live side, and none on the test side', async () => {
    const record = {
      id: 7,
      trace_id: TRACE,
      ngn_paid_kobo: 5_832_000,
      reference: 'GTB-1',
      supersedes_id: 6,
      recorded_by: 'owner',
      recorded_at: '2026-10-01T09:00:00Z',
    }
    const calls = fakeService({ float_topups: { data: [record] } })
    expect(await getTopupHistory(await principal(), 'live')).toEqual([
      {
        id: 7,
        traceId: TRACE,
        ngnPaidKobo: 5_832_000,
        reference: 'GTB-1',
        supersedesId: 6,
        recordedBy: 'owner',
        recordedAt: '2026-10-01T09:00:00Z',
      },
    ])
    expect(calls).not.toContainEqual(['in', 'id', []])
    const test = fakeService()
    await getTopupHistory(await principal(), 'test')
    expect(test).toContainEqual(['in', 'id', []])
    fakeService({ float_topups: { error: { code: 'x' } } })
    expect(await getTopupHistory(await principal(), 'live')).toBeNull()
  })

  it('reads the active costing rate, or none', async () => {
    const calls = fakeService({
      fx_rates: { data: [{ costing_rate: 1328.1, effective_from: 'x' }] },
    })
    expect(await getCostingRate(await principal({ testOnly: true }))).toBe(1328.1)
    expect(calls).toContainEqual(['eq', 'status', 'active'])
    fakeService({ fx_rates: { data: [] } })
    expect(await getCostingRate(await principal())).toBeNull()
    fakeService({ fx_rates: { error: { code: 'x' } } })
    expect(await getCostingRate(await principal())).toBeNull()
  })

  it('reads one page of calls on the side’s environment, filtered', async () => {
    const calls = fakeService({
      supplier_calls: {
        data: [
          {
            id: 9,
            created_at: '2026-10-01T09:00:00Z',
            operation: 'GetDetails',
            outcome: 'ok',
            domain_name: 'example.com',
            error_code: null,
            http_status: 200,
            duration_ms: 420,
            job_id: null,
            ssl_job_id: null,
          },
        ],
        count: 1,
      },
    })
    const params = parseCallsSearch({
      status: 'ok',
      op: 'GetDetails',
      job: '0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
      from: '2026-10-01',
      to: '2026-10-01',
    })
    const page = await getCalls(await principal(), 'test', params)
    expect(page).toEqual({
      rows: [
        {
          id: 9,
          createdAt: '2026-10-01T09:00:00Z',
          operation: 'GetDetails',
          outcome: 'ok',
          domainName: 'example.com',
          errorCode: null,
          httpStatus: 200,
          durationMs: 420,
          jobId: null,
          sslJobId: null,
        },
      ],
      total: 1,
    })
    expect(calls).toContainEqual(['eq', 'environment', 'ote'])
    expect(calls).toContainEqual(['in', 'outcome', ['ok']])
    expect(calls).toContainEqual(['eq', 'operation', 'GetDetails'])
    expect(calls).toContainEqual(['eq', 'job_id', '0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e'])
    expect(calls).toContainEqual(['range', 0, 49])
    expect(calls.find((call) => call[0] === 'select')?.[1]).not.toMatch(/message/)
    fakeService({ supplier_calls: { error: { code: 'x' } } })
    expect(await getCalls(await principal(), 'test', params)).toBeNull()
  })

  it('reads the weekly syncs’ heartbeats, hidden from a test administrator', async () => {
    expect(await getSyncHeartbeats(await principal({ testOnly: true }))).toBe('hidden')
    fakeService({
      service_heartbeats: {
        data: [
          {
            name: 'catalogue:production',
            beat_at: '2026-10-01T12:03:10Z',
            detail: { outcome: 'written', priceChanges: 2, otherChanges: 1 },
          },
        ],
      },
    })
    expect(await getSyncHeartbeats(await principal())).toEqual({
      tlds: { beatAt: '2026-10-01T12:03:10Z', outcome: 'written', changes: 3 },
      ssl: null,
    })
    fakeService({ service_heartbeats: { error: { code: 'x' } } })
    expect(await getSyncHeartbeats(await principal())).toBeNull()
    fakeService()
    expect(await getSyncHeartbeats({ ...whoami() } as never)).toBeNull()
  })
})
