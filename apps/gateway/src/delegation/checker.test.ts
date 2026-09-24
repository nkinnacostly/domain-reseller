import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../env'
import { createDelegationChecker, delegationCheckerFor } from './checker'
import type { ResolverView } from './resolvers'
import type { DelegationResult, DelegationStore, DueDomain } from './store'

/**
 * The checker's loop: which domains it checks, and what it records. The
 * resolvers are fakes — no real DNS in unit tests.
 */

const OURS = ['ns1.host.test', 'ns2.host.test']
const NOW = new Date('2026-09-28T12:00:00Z')

const domain = (id: string, over: Partial<DueDomain> = {}): DueDomain => ({
  id,
  domainName: `${id}.com`,
  nameservers: OURS,
  status: 'pending',
  ...over,
})

const seeing =
  (byDomain: Record<string, ResolverView[]>) =>
  async (name: string): Promise<ResolverView[]> =>
    byDomain[name] ?? [
      { resolver: 'Cloudflare', state: 'answered', nameservers: OURS },
      { resolver: 'Google', state: 'answered', nameservers: OURS },
    ]

function fakeStore(queue: DueDomain[], changes = new Map<string, Date>()) {
  const recorded: DelegationResult[][] = []
  let due = [...queue]
  const store = {
    due: vi.fn(async (_limit: number, _everyHours: number) => due),
    lastChanges: vi.fn(async (_ids: string[]) => changes),
    record: vi.fn(async (results: DelegationResult[]) => {
      recorded.push(results)
      // A recorded domain rests until it is due again.
      const done = new Set(results.map((result) => result.domainId))
      due = due.filter((item) => !done.has(item.id))
      return results.length
    }),
  } satisfies DelegationStore
  return { store, recorded }
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

function checker(store: DelegationStore, lookup = seeing({}), over: Record<string, unknown> = {}) {
  const logger = log()
  const instance = createDelegationChecker({
    store,
    lookup,
    everyMs: 30 * 60_000,
    log: logger,
    now: () => NOW,
    ...over,
  })
  return { instance, logger }
}

describe('the delegation checker', () => {
  it('never checks a domain still on the supplier’s default nameservers', async () => {
    const { store, recorded } = fakeStore([
      domain('parked', { status: 'undelegated' }),
      domain('empty', { nameservers: [] }),
      domain('pointed'),
    ])
    const lookup = vi.fn(seeing({}))
    const { instance } = checker(store, lookup)
    await instance.runOnce()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith('pointed.com')
    expect(recorded.flat().map((result) => result.domainId)).toEqual(['pointed'])
  })

  it('reads past parked domains to find the ones it can check', async () => {
    const { store } = fakeStore([domain('a')])
    const { instance } = checker(store)
    await instance.runOnce()
    expect(store.due).toHaveBeenCalledWith(500, 6)
  })

  it('records what each resolver saw, with the judgement', async () => {
    const failing: ResolverView[] = [
      { resolver: 'Cloudflare', state: 'nxdomain' },
      { resolver: 'Google', state: 'nxdomain' },
    ]
    const { store, recorded } = fakeStore([domain('ok'), domain('gone')])
    const { instance, logger } = checker(store, seeing({ 'gone.com': failing }))
    await expect(instance.runOnce()).resolves.toEqual({
      checked: 2,
      verified: 1,
      failed: 1,
      pending: 0,
    })
    expect(recorded[0]).toEqual([
      { domainId: 'ok', status: 'verified', observed: expect.any(Array) },
      { domainId: 'gone', status: 'failed', observed: failing },
    ])
    expect(logger.info).toHaveBeenCalledWith(
      { checked: 2, verified: 1, failed: 1, pending: 0 },
      'delegation check finished',
    )
  })

  it('does not fail a domain whose nameservers changed within the day', async () => {
    const old: ResolverView[] = [
      { resolver: 'Cloudflare', state: 'answered', nameservers: ['ns1.old.test'] },
      { resolver: 'Google', state: 'answered', nameservers: ['ns1.old.test'] },
    ]
    const changes = new Map([['fresh', new Date(NOW.getTime() - 3_600_000)]])
    const { store, recorded } = fakeStore([domain('fresh'), domain('stale')], changes)
    const { instance } = checker(store, seeing({ 'fresh.com': old, 'stale.com': old }))
    await instance.runOnce()
    expect(store.lastChanges).toHaveBeenCalledWith(['fresh', 'stale'])
    expect(recorded[0]?.map((result) => [result.domainId, result.status])).toEqual([
      ['fresh', 'pending'],
      ['stale', 'failed'],
    ])
  })

  it('works through the queue in batches until nothing is due', async () => {
    const queue = Array.from({ length: 5 }, (_, index) => domain(`d${index}`))
    const { store, recorded } = fakeStore(queue)
    const { instance } = checker(store, seeing({}), { batchSize: 2 })
    await expect(instance.runOnce()).resolves.toMatchObject({ checked: 5 })
    expect(recorded.map((batch) => batch.length)).toEqual([2, 2, 1])
  })

  it('stops a full batch when nothing more is due', async () => {
    const { store, recorded } = fakeStore([domain('a'), domain('b')])
    const { instance } = checker(store, seeing({}), { batchSize: 2 })
    await instance.runOnce()
    expect(recorded).toHaveLength(1)
    expect(store.due).toHaveBeenCalledTimes(2)
  })

  it('bounds one run, leaving the rest for the next', async () => {
    const queue = Array.from({ length: 10 }, (_, index) => domain(`d${index}`))
    const { store, recorded } = fakeStore(queue)
    const { instance } = checker(store, seeing({}), { batchSize: 2, maxBatches: 3 })
    await expect(instance.runOnce()).resolves.toMatchObject({ checked: 6 })
    expect(recorded).toHaveLength(3)
  })

  it('looks up only a few domains at once', async () => {
    let inFlight = 0
    let most = 0
    const lookup = async (name: string) => {
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return seeing({})(name)
    }
    const queue = Array.from({ length: 9 }, (_, index) => domain(`d${index}`))
    const { store } = fakeStore(queue)
    const { instance } = checker(store, lookup, { concurrency: 3 })
    await instance.runOnce()
    expect(most).toBe(3)
  })

  it('says nothing when nothing was due', async () => {
    const { store } = fakeStore([])
    const { instance, logger } = checker(store)
    await expect(instance.runOnce()).resolves.toEqual({
      checked: 0,
      verified: 0,
      failed: 0,
      pending: 0,
    })
    expect(logger.info).not.toHaveBeenCalled()
    expect(store.lastChanges).not.toHaveBeenCalled()
  })

  it('logs a failed run and carries on at the next interval', async () => {
    vi.useFakeTimers()
    try {
      const { store } = fakeStore([domain('a')])
      store.due.mockRejectedValueOnce(new Error('database down'))
      const { instance, logger } = checker(store)
      instance.start()
      instance.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'delegation check failed',
      )
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(store.record).toHaveBeenCalledTimes(1)
      await instance.stop()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(store.due).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops cleanly when stopped mid-run', async () => {
    const { store, recorded } = fakeStore([domain('a')])
    const { instance } = checker(store)
    instance.start()
    await instance.stop()
    expect(recorded).toHaveLength(1)
  })
})

describe('where the checker runs', () => {
  const BASE = {
    GATEWAY_SHARED_SECRET: 'test-secret-value-at-least-16',
    DNA_RESELLER_ID: '00000000-0000-0000-0000-000000000000',
    DNA_API_KEY: 'x',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SECRET_KEY: 'x',
  }
  const flw = (key: string) => ({ FLUTTERWAVE_SECRET_KEY: key })

  it('not on a gateway without live registrations: a laptop, the sandbox, or writes off', () => {
    expect(delegationCheckerFor(parseEnv(BASE), log())).toBeNull()
    expect(
      delegationCheckerFor(
        parseEnv({
          ...BASE,
          ...flw('FLWSECK_TEST-0000000000000000-X'),
          DNA_WRITE_ENV: 'ote',
          DNA_API_TEST_KEY: 'ote',
        }),
        log(),
      ),
    ).toBeNull()
  })

  const LIVE = parseEnv({
    ...BASE,
    ...flw('FLWSECK-0000000000000000-X'),
    NODE_ENV: 'production',
    DNA_WRITE_ENV: 'production',
  })

  it('on the gateway that registers on the live registry', () => {
    expect(delegationCheckerFor(LIVE, log())).not.toBeNull()
  })

  it('checks live domains end to end: due list, activity log, resolvers, record', async () => {
    const rpcs: { fn: string; args: unknown }[] = []
    const events = {
      select: () => events,
      in: () => events,
      order: async () => ({ data: [], error: null }),
    }
    let due = [
      {
        domain_id: 'd1',
        domain_name: 'example.com',
        nameservers: ['ns1.host.test'],
        delegation_status: 'pending',
      },
    ]
    const client = {
      rpc: async (fn: string, args: unknown) => {
        rpcs.push({ fn, args })
        if (fn === 'domains_for_delegation_check') return { data: due, error: null }
        due = []
        return { data: 1, error: null }
      },
      from: () => events,
    }
    const fetchImpl = vi.fn(async () =>
      Response.json({
        Status: 0,
        Answer: [{ name: 'example.com.', type: 2, data: 'ns1.host.test.' }],
      }),
    )
    const created = delegationCheckerFor(LIVE, log(), {
      client: client as never,
      fetchImpl: fetchImpl as never,
    })
    await expect(created?.runOnce()).resolves.toMatchObject({ checked: 1, verified: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(rpcs.map((call) => call.fn)).toEqual([
      'domains_for_delegation_check',
      'record_delegation_checks',
    ])
  })
})
