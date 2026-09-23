import { describe, expect, it, vi } from 'vitest'
import type { PortfolioReader, RegistryListing, Write } from '../provisioning/registrar'
import type { Comparison, OurDomain } from './compare'
import { createReconciler } from './reconciler'
import type { ReconcileStore } from './store'

const NOW = new Date('2026-09-23T12:00:00.000Z')

const listing = (name: string): RegistryListing => ({
  domainName: name,
  status: 'Active',
  expiresAt: '2027-09-23T08:44:10.000Z',
  nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
  transferLock: true,
  privacy: false,
  renewalMode: 'AutoRenew',
})

function fakeStore(options: { begin?: string | null; ours?: OurDomain[] } = {}) {
  const recorded: { runId: string; comparison: Comparison; seen: number }[] = []
  const failed: { runId: string; error: string }[] = []
  const begins: [boolean, number][] = []
  const store: ReconcileStore = {
    async begin(testMode, minIntervalSeconds) {
      begins.push([testMode, minIntervalSeconds])
      return options.begin === undefined ? 'run-1' : options.begin
    },
    async loadOurs() {
      return options.ours ?? []
    },
    async record(runId, comparison, seen) {
      recorded.push({ runId, comparison, seen })
      return comparison.findings.length
    },
    async fail(runId, error) {
      failed.push({ runId, error })
    },
  }
  return { store, recorded, failed, begins }
}

/** Serves `names` in pages, optionally failing one page. */
function reader(names: string[], failOnSkip?: number): PortfolioReader & { skips: number[] } {
  const skips: number[] = []
  return {
    skips,
    async listPage(skip, take): Promise<Write<{ items: RegistryListing[]; total: number }>> {
      skips.push(skip)
      if (skip === failOnSkip) return { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' }
      return {
        kind: 'ok',
        data: { items: names.slice(skip, skip + take).map(listing), total: names.length },
      }
    },
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function reconciler(store: ReconcileStore, portfolio: PortfolioReader, over = {}) {
  return createReconciler({
    store,
    reader: portfolio,
    testMode: true,
    everyMs: 3_600_000,
    log,
    pageSize: 2,
    now: () => NOW,
    ...over,
  })
}

describe('reconciler (PRD §13.5)', () => {
  it('reads every page, then records one comparison', async () => {
    const { store, recorded } = fakeStore()
    const portfolio = reader(['a.com', 'b.com', 'c.com', 'd.com', 'e.com'])
    const result = await reconciler(store, portfolio).runOnce()

    expect(portfolio.skips).toEqual([0, 2, 4])
    expect(result).toMatchObject({ status: 'done', seen: 5 })
    expect(recorded).toHaveLength(1)
    // Nothing of ours, so all five are unknown to us.
    expect(recorded[0]?.comparison.findings.map((finding) => finding.kind)).toEqual(
      Array(5).fill('unknown_domain'),
    )
  })

  it('records nothing when a page cannot be read — a partial listing would look like missing domains', async () => {
    const { store, recorded, failed } = fakeStore({
      ours: [
        {
          id: 'd1',
          domainName: 'c.com',
          localStatus: 'active',
          expiresAt: null,
          nameservers: null,
          pendingNameservers: null,
          autoRenew: true,
          transferLock: true,
          privacy: false,
        },
      ],
    })
    const result = await reconciler(store, reader(['a.com', 'b.com', 'c.com'], 2)).runOnce()

    expect(result).toEqual({ status: 'failed', reason: 'TIMEOUT: No answer' })
    expect(recorded).toEqual([])
    expect(failed).toEqual([{ runId: 'run-1', error: 'TIMEOUT: No answer' }])
  })

  it('does nothing when a run finished within the interval', async () => {
    const { store, recorded, begins } = fakeStore({ begin: null })
    const portfolio = reader(['a.com'])
    await expect(reconciler(store, portfolio).runOnce()).resolves.toEqual({ status: 'skipped' })
    expect(begins).toEqual([[true, 3600]])
    expect(portfolio.skips).toEqual([])
    expect(recorded).toEqual([])
  })

  it('runs now when forced', async () => {
    const { store, begins } = fakeStore()
    await reconciler(store, reader([])).runOnce({ force: true })
    expect(begins).toEqual([[true, 0]])
  })

  it('stops a run that crashes, and says so', async () => {
    const { store, failed } = fakeStore()
    store.loadOurs = async () => {
      throw new Error('database unavailable')
    }
    await expect(reconciler(store, reader(['a.com'])).runOnce()).resolves.toEqual({
      status: 'failed',
      reason: 'database unavailable',
    })
    expect(failed).toEqual([{ runId: 'run-1', error: 'database unavailable' }])
  })

  it('logs findings that cost money at error level', async () => {
    log.error.mockClear()
    const { store } = fakeStore({
      ours: [
        {
          id: 'd1',
          domainName: 'a.com',
          localStatus: 'active',
          expiresAt: '2026-10-01T00:00:00.000Z',
          nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
          pendingNameservers: null,
          autoRenew: true,
          transferLock: true,
          privacy: false,
        },
      ],
    })
    await reconciler(store, reader(['a.com'])).runOnce()
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ findings: { supplier_renewed: 1 } }),
      'reconcile finished',
    )
  })

  it('tries again after five minutes when a run fails, not an hour', async () => {
    vi.useFakeTimers()
    try {
      const { store, begins } = fakeStore()
      const begin = store.begin
      let calls = 0
      store.begin = async (...args) => {
        calls += 1
        if (calls === 1) throw new Error('fetch failed')
        return begin(...args)
      }
      const instance = reconciler(store, reader(['a.com']))
      instance.start()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(calls).toBe(2)
      expect(begins).toHaveLength(1)
      // After a good run, the next waits the full interval.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(calls).toBe(2)
      await instance.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs on start and stops cleanly', async () => {
    const { store, recorded } = fakeStore()
    const instance = reconciler(store, reader(['a.com']))
    instance.start()
    await instance.stop()
    expect(recorded).toHaveLength(1)
  })
})
