import { describe, expect, it, vi } from 'vitest'
import type { AdminSupplier } from '../admin/supplier'
import { fakeRpcClient } from '../test-support/fake-supabase'
import { LedgerReadError, toLedgerRow } from './normalize'
import { createLedgerSource, LEDGER_MAX_PAGES, supplierDay } from './source'
import { createLedgerStore } from './store'
import { createLedgerSync, LEDGER_EPOCH, ledgerHeartbeat } from './sync'

/**
 * The supplier ledger mirror (ADMIN-SPEC §4.4, §4.6). Fixtures follow the
 * five live entries read on 2 Oct 2026 — the non-RFC GUID (version `b`,
 * variant `7`) and the upper-case debit traces included — with descriptions
 * made up.
 */

const TOPUP = {
  traceId: '38e14b09-3eb8-b811-78ce-3a2400360393',
  creationTime: '2026-09-29T19:39:33.5269574',
  type: 5,
  status: 1,
  chargeType: 0,
  productType: 3,
  productId: null,
  period: 1,
  amount: 0,
  exchangeAmount: 0,
  resellerName: 'Our reseller name',
  oldBalance: 7.38,
  balance: 43.38,
  description: 'Ziraat Payment (Order: 20260929193857113-32A4)',
}
const DEBIT = {
  traceId: '3959267D-1A8C-47FB-938E-3A23F136233E',
  creationTime: '2026-09-26T21:45:25.1333333',
  type: 1,
  status: 1,
  chargeType: 1,
  productType: 1,
  productId: '4E672064-631F-A813-59C2-3A23F1362344',
  period: 1,
  amount: 0,
  oldBalance: 18.69,
  balance: 7.38,
  description: 'example-client.com',
}

describe('a ledger row', () => {
  it('is in cents from the balances, at UTC+3, with its GUIDs lower-cased', () => {
    expect(toLedgerRow(DEBIT)).toEqual({
      traceId: '3959267d-1a8c-47fb-938e-3a23f136233e',
      occurredAt: '2026-09-26T18:45:25.133Z',
      type: 1,
      status: 1,
      chargeType: 1,
      productType: 1,
      productId: '4e672064-631f-a813-59c2-3a23f1362344',
      description: 'example-client.com',
      period: 1,
      oldBalanceCents: 1869,
      balanceCents: 738,
    })
    const topup = toLedgerRow(TOPUP)
    expect(topup.traceId).toBe('38e14b09-3eb8-b811-78ce-3a2400360393')
    expect(topup.balanceCents - topup.oldBalanceCents).toBe(3600)
    expect(JSON.stringify(topup)).not.toContain('Our reseller name')
  })

  it('refuses the whole read for an entry it cannot trust', () => {
    expect(() => toLedgerRow({ ...DEBIT, traceId: 'not-a-guid' })).toThrow(LedgerReadError)
    expect(() => toLedgerRow({ ...DEBIT, traceId: undefined })).toThrow('traceId')
    expect(() => toLedgerRow({ ...DEBIT, balance: 'lots' })).toThrow('unreadable balance')
    expect(() => toLedgerRow({ ...DEBIT, creationTime: 'yesterday' })).toThrow('no readable time')
    expect(() => toLedgerRow({ ...DEBIT, type: 1.5 })).toThrow(LedgerReadError)
    expect(() => toLedgerRow(null)).toThrow(LedgerReadError)
  })

  it('keeps a missing description and period as empty, and drops an odd product id', () => {
    const row = toLedgerRow({ ...DEBIT, description: null, period: null, productId: 'x' })
    expect(row).toMatchObject({ description: '', period: null, productId: null })
  })
})

type Page = { status: number; body: unknown }

function source(pages: Page[], now = new Date('2026-10-02T21:30:00Z')) {
  const asked: { params: Record<string, unknown>; lane: unknown }[] = []
  const supplier: AdminSupplier = {
    environment: 'production',
    get: vi.fn(async (_path, params, lane) => {
      asked.push({ params: params as Record<string, unknown>, lane })
      const page = pages[asked.length - 1]
      if (!page) throw new Error('no more pages')
      return page
    }),
    postRead: vi.fn(),
  }
  return { read: createLedgerSource({ supplier, now: () => now, pageSize: 2 }), asked }
}

describe('reading the ledger', () => {
  it('always sends both dates — since minus a day to tomorrow, in UTC+3 days — sorted oldest first, in the low lane', async () => {
    // StartDate alone is ignored by the supplier (seen 2 Oct 2026): never send it alone.
    const { read, asked } = source([{ status: 200, body: { totalCount: 1, items: [TOPUP] } }])
    await read(new Date('2026-09-29T22:30:00Z'))
    expect(asked[0]?.params).toEqual({
      StartDate: '2026-09-29',
      EndDate: '2026-10-04',
      Sorting: 'creationTime asc',
      SkipCount: 0,
      MaxResultCount: 2,
    })
    expect(asked[0]?.lane).toEqual({ priority: 'low', waitMs: 60_000 })
    expect(supplierDay(Date.parse('2026-10-02T21:30:00Z'))).toBe('2026-10-03')
  })

  it('pages until a short page, and keeps one row per trace', async () => {
    const { read, asked } = source([
      { status: 200, body: { totalCount: 3, items: [TOPUP, DEBIT] } },
      { status: 200, body: { totalCount: 3, items: [TOPUP] } },
    ])
    const result = await read(new Date('2026-09-20T00:00:00Z'))
    expect(asked.map((ask) => ask.params.SkipCount)).toEqual([0, 2])
    expect(result.read).toBe(3)
    expect(result.rows.map((row) => row.traceId)).toEqual([
      '38e14b09-3eb8-b811-78ce-3a2400360393',
      '3959267d-1a8c-47fb-938e-3a23f136233e',
    ])
    expect(result.readAt).toBe('2026-10-02T21:30:00.000Z')
  })

  it('filters back to a day before `since`, in UTC', async () => {
    const { read } = source([
      { status: 200, body: { totalCount: 2, items: [DEBIT, TOPUP] } },
      { status: 200, body: { totalCount: 2, items: [] } },
    ])
    // The debit (26 Sept) is more than a day before; the top-up (29 Sept) is not.
    const result = await read(new Date('2026-09-29T00:00:00Z'))
    expect(result.rows.map((row) => row.traceId)).toEqual(['38e14b09-3eb8-b811-78ce-3a2400360393'])
  })

  it('refuses a read that does not add up to the supplier’s count', async () => {
    const { read } = source([{ status: 200, body: { totalCount: 5, items: [TOPUP] } }])
    await expect(read(LEDGER_EPOCH)).rejects.toThrow('Read 1 of 5 ledger entries')
    const noCount = source([{ status: 200, body: { items: [TOPUP] } }])
    await expect(noCount.read(LEDGER_EPOCH)).rejects.toThrow('Read 1 of an unknown number')
  })

  it('refuses a page that is not a listing, or an error answer', async () => {
    await expect(
      source([{ status: 200, body: { nope: true } }]).read(LEDGER_EPOCH),
    ).rejects.toThrow('not a listing')
    await expect(source([{ status: 403, body: {} }]).read(LEDGER_EPOCH)).rejects.toThrow('HTTP 403')
  })

  it(`stops after ${LEDGER_MAX_PAGES} pages`, async () => {
    const supplier: AdminSupplier = {
      environment: 'ote',
      get: vi.fn(async () => ({
        status: 200,
        body: { totalCount: 1_000_000, items: [TOPUP, DEBIT] },
      })),
      postRead: vi.fn(),
    }
    const read = createLedgerSource({ supplier, pageSize: 2, maxPages: 3 })
    await expect(read(LEDGER_EPOCH)).rejects.toThrow('ran past 3 pages')
    expect(supplier.get).toHaveBeenCalledTimes(3)
  })
})

function store(over: Partial<ReturnType<typeof baseStore>> = {}) {
  return { ...baseStore(), ...over }
}
function baseStore() {
  return {
    latestOccurredAt: vi.fn(async (): Promise<Date | null> => new Date('2026-09-29T16:39:33.526Z')),
    record: vi.fn(async () => ({ inserted: 1, statusChanged: 0, revised: 0 })),
    lastOkReadAt: vi.fn(async () => '2026-10-02T20:30:00.000Z'),
    beat: vi.fn(async () => {}),
  }
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('the ledger sync', () => {
  it('reads since the newest entry, records the rows and beats with readAt', async () => {
    const s = store()
    const read = vi.fn(async () => ({
      rows: [toLedgerRow(TOPUP)],
      read: 1,
      readAt: '2026-10-02T21:30:00.000Z',
    }))
    const sync = createLedgerSync({
      source: read,
      store: s,
      testMode: false,
      everyMs: 60_000,
      log: log(),
    })
    expect(await sync.runOnce()).toEqual({
      outcome: 'ok',
      read: 1,
      inserted: 1,
      statusChanged: 0,
      revised: 0,
    })
    expect(read).toHaveBeenCalledWith(new Date('2026-09-29T16:39:33.526Z'))
    expect(s.record).toHaveBeenCalledWith(false, [
      expect.objectContaining({ traceId: TOPUP.traceId }),
    ])
    expect(s.beat).toHaveBeenCalledWith('supplier_ledger:production', false, {
      outcome: 'ok',
      read: 1,
      inserted: 1,
      statusChanged: 0,
      revised: 0,
      lastOccurredAt: '2026-09-29T16:39:33.526Z',
      readAt: '2026-10-02T21:30:00.000Z',
    })
  })

  it('starts from the epoch before the first entry, on the sandbox side', async () => {
    const s = store({ latestOccurredAt: vi.fn(async () => null) })
    const read = vi.fn(async () => ({ rows: [], read: 0, readAt: '2026-10-02T21:30:00.000Z' }))
    const sync = createLedgerSync({
      source: read,
      store: s,
      testMode: true,
      everyMs: 60_000,
      log: log(),
    })
    await sync.runOnce()
    expect(read).toHaveBeenCalledWith(LEDGER_EPOCH)
    expect(s.beat).toHaveBeenCalledWith(
      'supplier_ledger:ote',
      true,
      expect.objectContaining({ lastOccurredAt: null }),
    )
    expect(ledgerHeartbeat(true)).toBe('supplier_ledger:ote')
  })

  it('records nothing when the read is refused, and beats failed with the last good read', async () => {
    const s = store()
    const logger = log()
    const read = vi.fn(async () => {
      throw new Error('Read 1 of 5 ledger entries')
    })
    const sync = createLedgerSync({
      source: read,
      store: s,
      testMode: false,
      everyMs: 60_000,
      log: logger,
      now: () => new Date('2026-10-02T21:30:00Z'),
    })
    expect(await sync.runOnce()).toEqual({
      outcome: 'failed',
      reason: 'Read 1 of 5 ledger entries',
    })
    expect(s.record).not.toHaveBeenCalled()
    expect(s.beat).toHaveBeenCalledWith('supplier_ledger:production', false, {
      outcome: 'failed',
      reason: 'Read 1 of 5 ledger entries',
      startedAt: '2026-10-02T21:30:00.000Z',
      lastOkReadAt: '2026-10-02T20:30:00.000Z',
    })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('passes a status change through as the database reports it, and logs it', async () => {
    const s = store({ record: vi.fn(async () => ({ inserted: 0, statusChanged: 1, revised: 1 })) })
    const logger = log()
    const read = vi.fn(async () => ({
      rows: [toLedgerRow(DEBIT)],
      read: 1,
      readAt: '2026-10-02T21:30:00.000Z',
    }))
    const sync = createLedgerSync({
      source: read,
      store: s,
      testMode: false,
      everyMs: 60_000,
      log: logger,
    })
    expect(await sync.runOnce()).toMatchObject({ statusChanged: 1, revised: 1 })
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ statusChanged: 1 }),
      'supplier ledger read',
    )
  })

  it('survives a heartbeat it could not record', async () => {
    const logger = log()
    const s = store({
      beat: vi.fn(async () => {
        throw new Error('db down')
      }),
    })
    const read = vi.fn(async () => ({ rows: [], read: 0, readAt: 'x' }))
    const sync = createLedgerSync({
      source: read,
      store: s,
      testMode: false,
      everyMs: 60_000,
      log: logger,
    })
    await expect(sync.runOnce()).resolves.toMatchObject({ outcome: 'ok' })
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Object),
      'supplier ledger heartbeat not recorded',
    )
  })

  it('runs on its interval and stops cleanly', async () => {
    vi.useFakeTimers()
    try {
      const read = vi.fn(async () => ({ rows: [], read: 0, readAt: 'x' }))
      const sync = createLedgerSync({
        source: read,
        store: store(),
        testMode: false,
        everyMs: 60_000,
        log: log(),
      })
      sync.start()
      sync.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(read).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(read).toHaveBeenCalledTimes(2)
      await sync.stop()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the ledger store', () => {
  function tableClient(answer: { data?: unknown; error?: { message: string } | null }) {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'order']) builder[method] = vi.fn(() => builder)
    builder.limit = vi.fn(async () => answer)
    builder.maybeSingle = vi.fn(async () => answer)
    return { from: vi.fn(() => builder), builder }
  }

  it('finds the newest entry on a side', async () => {
    const { from } = tableClient({
      data: [{ occurred_at: '2026-09-29T16:39:33.526Z' }],
      error: null,
    })
    expect(await createLedgerStore({ from } as never).latestOccurredAt(false)).toEqual(
      new Date('2026-09-29T16:39:33.526Z'),
    )
    const empty = tableClient({ data: [], error: null })
    expect(await createLedgerStore({ from: empty.from } as never).latestOccurredAt(true)).toBeNull()
    const broken = tableClient({ data: null, error: { message: 'down' } })
    await expect(
      createLedgerStore({ from: broken.from } as never).latestOccurredAt(true),
    ).rejects.toThrow('down')
  })

  it('records rows and returns what the database did', async () => {
    const { client, rpc } = fakeRpcClient({
      record_supplier_ledger: { data: { inserted: 5, statusChanged: 0, revised: 0 } },
    })
    const row = toLedgerRow(TOPUP)
    expect(await createLedgerStore(client).record(false, [row])).toEqual({
      inserted: 5,
      statusChanged: 0,
      revised: 0,
    })
    expect(rpc).toHaveBeenCalledWith('record_supplier_ledger', {
      p_test_mode: false,
      p_rows: [row],
    })
    const none = fakeRpcClient({})
    expect(await createLedgerStore(none.client).record(true, [])).toEqual({
      inserted: 0,
      statusChanged: 0,
      revised: 0,
    })
    const refused = fakeRpcClient({ record_supplier_ledger: { error: { message: 'not a GUID' } } })
    await expect(createLedgerStore(refused.client).record(true, [])).rejects.toThrow('not a GUID')
  })

  it('reads the last good read from the heartbeat, and beats', async () => {
    const ok = tableClient({ data: { detail: { outcome: 'ok', readAt: 'A' } }, error: null })
    expect(
      await createLedgerStore({ from: ok.from } as never).lastOkReadAt(
        'supplier_ledger:production',
      ),
    ).toBe('A')
    const failed = tableClient({
      data: { detail: { outcome: 'failed', lastOkReadAt: 'B' } },
      error: null,
    })
    expect(await createLedgerStore({ from: failed.from } as never).lastOkReadAt('x')).toBe('B')
    const never = tableClient({ data: null, error: null })
    expect(await createLedgerStore({ from: never.from } as never).lastOkReadAt('x')).toBeNull()
    const broken = tableClient({ data: null, error: { message: 'down' } })
    await expect(
      createLedgerStore({ from: broken.from } as never).lastOkReadAt('x'),
    ).rejects.toThrow('down')
    const { client, rpc } = fakeRpcClient()
    await createLedgerStore(client).beat('supplier_ledger:ote', true, { outcome: 'ok' })
    expect(rpc).toHaveBeenCalledWith('record_heartbeat', {
      p_name: 'supplier_ledger:ote',
      p_test_mode: true,
      p_detail: { outcome: 'ok' },
    })
    const refused = fakeRpcClient({ record_heartbeat: { error: { message: 'no' } } })
    await expect(createLedgerStore(refused.client).beat('x', true, {})).rejects.toThrow('no')
  })
})
