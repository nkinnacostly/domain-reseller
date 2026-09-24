import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../env'
import { catalogueScheduleFor, createCatalogueSchedule, isDue } from './schedule'
import type { LastRun, RunLog } from './store'
import type { SyncResult } from './sync'

/**
 * The weekly sync inside the gateway. What matters: it runs once a week
 * however often the gateway restarts, a failure is recorded where it can be
 * seen and retried soon, and only a production gateway reading the live
 * catalogue ever writes it.
 */

const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR
const NOW = new Date('2026-09-28T06:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  outcome: 'unchanged',
  reason: null,
  listed: 723,
  sellable: 701,
  diff: { added: [], retired: [], priceChanges: [], detailChanges: [], unchanged: 701 },
  report: [],
  ...over,
})

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

function runLog(last: LastRun | null = null) {
  return {
    last: vi.fn(async () => last),
    record: vi.fn(async (_detail: Record<string, unknown>) => {}),
  } satisfies RunLog
}

function schedule(
  runs: ReturnType<typeof runLog>,
  sync: () => Promise<SyncResult>,
  over: Partial<Parameters<typeof createCatalogueSchedule>[0]> = {},
) {
  const logger = log()
  const instance = createCatalogueSchedule({
    sync,
    runs,
    everyMs: WEEK,
    log: logger,
    now: () => NOW,
    ...over,
  })
  return { instance, logger }
}

describe('isDue', () => {
  it('is due when nothing has run yet', () => {
    expect(isDue(null, NOW, WEEK, HOUR)).toBe(true)
  })

  it('is not due within a week of a success, whatever happened since', () => {
    const success = { outcome: 'written', lastSuccessAt: ago(6 * 24 * HOUR).toISOString() }
    expect(isDue({ at: ago(6 * 24 * HOUR), detail: success }, NOW, WEEK, HOUR)).toBe(false)
  })

  it('is due a week after the last success', () => {
    const detail = { outcome: 'unchanged', lastSuccessAt: ago(WEEK).toISOString() }
    expect(isDue({ at: ago(WEEK), detail }, NOW, WEEK, HOUR)).toBe(true)
  })

  it('waits an hour after a failure or refusal before trying again', () => {
    for (const outcome of ['failed', 'refused']) {
      const detail = { outcome, lastSuccessAt: ago(8 * 24 * HOUR).toISOString() }
      expect(isDue({ at: ago(30 * 60_000), detail }, NOW, WEEK, HOUR)).toBe(false)
      expect(isDue({ at: ago(HOUR), detail }, NOW, WEEK, HOUR)).toBe(true)
    }
  })

  it('does not trust a success time it cannot read', () => {
    expect(isDue({ at: ago(HOUR), detail: { lastSuccessAt: 'yesterday' } }, NOW, WEEK, HOUR)).toBe(
      true,
    )
    expect(isDue({ at: ago(HOUR), detail: { lastSuccessAt: 42 } }, NOW, WEEK, HOUR)).toBe(true)
  })
})

describe('the weekly catalogue sync', () => {
  it('does not start when it cannot tell whether this week’s sync is done', async () => {
    const runs = runLog()
    runs.last.mockRejectedValueOnce(new Error('Could not read the last catalogue sync: down'))
    const sync = vi.fn(async () => result())
    const { instance, logger } = schedule(runs, sync)
    await expect(instance.runOnce()).resolves.toEqual({
      status: 'failed',
      reason: 'Could not read the last catalogue sync: down',
    })
    expect(sync).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()

    runs.last.mockRejectedValueOnce('timeout')
    await expect(instance.runOnce()).resolves.toEqual({ status: 'failed', reason: 'timeout' })
  })

  it('records a failure, keeping the last success, and leaves the costs alone', async () => {
    const lastSuccessAt = ago(8 * 24 * HOUR).toISOString()
    const runs = runLog({ at: ago(8 * 24 * HOUR), detail: { outcome: 'unchanged', lastSuccessAt } })
    const { instance, logger } = schedule(runs, async () => {
      throw new Error('HTTP 403: address not allowed')
    })
    await expect(instance.runOnce()).resolves.toEqual({
      status: 'failed',
      reason: 'HTTP 403: address not allowed',
    })
    expect(runs.record).toHaveBeenCalledWith({
      outcome: 'failed',
      reason: 'HTTP 403: address not allowed',
      lastSuccessAt,
    })
    expect(logger.error).toHaveBeenCalledWith(
      { reason: 'HTTP 403: address not allowed' },
      'catalogue sync failed; costs unchanged',
    )
  })

  it('records a refused listing as a failure to look at', async () => {
    const runs = runLog()
    const refused = result({
      outcome: 'refused',
      reason: 'The supplier said 723 extensions and listed 250',
      diff: null,
    })
    const refresh = vi.fn(async () => true)
    const { instance, logger } = schedule(runs, async () => refused, { refreshPrices: refresh })
    await expect(instance.runOnce()).resolves.toEqual({
      status: 'done',
      result: refused,
      pricesRefreshed: null,
    })
    expect(runs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'refused',
        reason: 'The supplier said 723 extensions and listed 250',
        lastSuccessAt: null,
      }),
    )
    expect(refresh).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it('skips a sync that is not due, without asking the supplier', async () => {
    const runs = runLog({
      at: ago(HOUR),
      detail: { outcome: 'unchanged', lastSuccessAt: ago(HOUR).toISOString() },
    })
    const sync = vi.fn(async () => result())
    const { instance } = schedule(runs, sync)
    await expect(instance.runOnce()).resolves.toEqual({ status: 'skipped' })
    expect(sync).not.toHaveBeenCalled()
    expect(runs.record).not.toHaveBeenCalled()
  })

  it('asks the site to refresh its prices after writing new costs', async () => {
    const runs = runLog()
    const refresh = vi.fn(async () => true)
    const written = result({ outcome: 'written' })
    const { instance, logger } = schedule(runs, async () => written, { refreshPrices: refresh })
    await expect(instance.runOnce()).resolves.toEqual({
      status: 'done',
      result: written,
      pricesRefreshed: true,
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(runs.record).toHaveBeenCalledWith({
      outcome: 'written',
      listed: 723,
      sellable: 701,
      added: 0,
      retired: 0,
      priceChanges: 0,
      otherChanges: 0,
      pricesRefreshed: true,
      lastSuccessAt: NOW.toISOString(),
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('still counts the sync a success when the site does not refresh', async () => {
    const runs = runLog()
    const { instance, logger } = schedule(runs, async () => result({ outcome: 'written' }), {
      refreshPrices: async () => false,
    })
    await instance.runOnce()
    expect(runs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'written',
        pricesRefreshed: false,
        lastSuccessAt: NOW.toISOString(),
      }),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      {},
      'site did not refresh its prices; it will within the hour',
    )
  })

  it('does not ask the site to refresh when nothing changed, or when it has no address', async () => {
    const refresh = vi.fn(async () => true)
    await schedule(runLog(), async () => result(), { refreshPrices: refresh }).instance.runOnce()
    expect(refresh).not.toHaveBeenCalled()

    const runs = runLog()
    await schedule(runs, async () => result({ outcome: 'written' })).instance.runOnce()
    expect(runs.record).toHaveBeenCalledWith(expect.objectContaining({ pricesRefreshed: null }))
  })

  it('logs, rather than throws, when the outcome cannot be recorded', async () => {
    const runs = runLog()
    runs.record.mockRejectedValueOnce(new Error('down'))
    const { instance, logger } = schedule(runs, async () => result())
    await expect(instance.runOnce()).resolves.toMatchObject({ status: 'done' })
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'catalogue sync outcome not recorded',
    )
  })

  it('shortens a long failure before recording it', async () => {
    const runs = runLog()
    await schedule(runs, async () => {
      throw 'x'.repeat(500)
    }).instance.runOnce()
    expect(String(runs.record.mock.calls[0]?.[0]?.reason)).toHaveLength(300)
  })

  it('looks on start, then every half hour, and stops cleanly', async () => {
    vi.useFakeTimers()
    try {
      const runs = runLog()
      const sync = vi.fn(async () => result())
      const { instance } = schedule(runs, sync, { now: () => new Date() })
      instance.start()
      instance.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(runs.last).toHaveBeenCalledTimes(1)
      expect(sync).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(runs.last).toHaveBeenCalledTimes(2)
      await instance.stop()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(runs.last).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops cleanly when stopped mid-run', async () => {
    const runs = runLog()
    const { instance } = schedule(runs, async () => result())
    instance.start()
    await instance.stop()
    expect(runs.record).toHaveBeenCalledTimes(1)
  })
})

describe('where the schedule runs', () => {
  const BASE = {
    GATEWAY_SHARED_SECRET: 'test-secret-value-at-least-16',
    DNA_RESELLER_ID: '00000000-0000-0000-0000-000000000000',
    DNA_API_KEY: 'x',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SECRET_KEY: 'x',
  }

  it.each([
    ['a laptop reading the live catalogue', { NODE_ENV: 'development', DNA_ENV: 'production' }],
    ['a production gateway reading the sandbox', { NODE_ENV: 'production', DNA_ENV: 'ote' }],
    ['a test run', { NODE_ENV: 'test', DNA_ENV: 'production' }],
  ])('never on %s', (_, over) => {
    expect(catalogueScheduleFor(parseEnv({ ...BASE, ...over }), log())).toBeNull()
  })

  const production = { ...BASE, NODE_ENV: 'production', DNA_ENV: 'production' }

  it('on the production gateway reading the live catalogue', () => {
    const created = catalogueScheduleFor(parseEnv(production), log())
    expect(created).not.toBeNull()
    expect(typeof created?.start).toBe('function')
  })

  it('reads the live listing, writes it, records the run and refreshes the site', async () => {
    const writes: unknown[][] = []
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      range: async () => ({ data: [], error: null }),
      upsert: async (rows: unknown[]) => {
        writes.push(['upsert', rows.length])
        return { error: null }
      },
    }
    const client = {
      from: () => query,
      rpc: async (fn: string, args: { p_name: string; p_test_mode: boolean }) => {
        writes.push([fn, args.p_name, args.p_test_mode])
        return { data: null, error: null }
      },
    }
    const getJson = vi.fn(async (_url: string) => ({
      totalCount: 1,
      items: [
        { name: 'com', prices: [{ register: [{ period: 1, price: 11.31, currency: 'USD' }] }] },
      ],
    }))
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json({ ok: true }))

    const created = catalogueScheduleFor(
      parseEnv({ ...production, APP_URL: 'https://www.mydomainshub.com' }),
      log(),
      { client: client as never, getJson: getJson as never, fetchImpl: fetchImpl as never },
    )
    await expect(created?.runOnce()).resolves.toMatchObject({
      status: 'done',
      result: { outcome: 'written' },
      pricesRefreshed: true,
    })
    expect(getJson.mock.calls[0]?.[0]).toMatch(/^https:\/\/api\.domainresellerapi\.com\//)
    expect(writes).toEqual([
      ['upsert', 1],
      ['record_heartbeat', 'catalogue:production', false],
    ])
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://www.mydomainshub.com/api/pricing/refresh',
    )
  })
})
