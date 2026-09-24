import type { AvailabilityStatus } from '@dr/shared'
import type DomainNameApi from 'nodejs-dna'
import type { DnaAvailability, DnaFail } from 'nodejs-dna'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { TokenBucket } from '../lib/rate-limit'
import { Semaphore } from '../lib/semaphore'
import { TtlCache } from '../lib/ttl-cache'
import { createAvailabilityRoute, toBatches, toCalls } from './availability'

const SECRET = process.env.GATEWAY_SHARED_SECRET as string

type Check = (names: string[], tlds: string[]) => Promise<DnaAvailability[] | DnaFail>
type Results = { results: { name: string; tld: string; domain: string; status: string }[] }

/** Every pair available — the supplier's shape, one row per name × extension. */
const available = (names: string[], tlds: string[]): DnaAvailability[] =>
  names.flatMap((DomainName) =>
    tlds.map((TLD) => ({ DomainName, TLD, Status: 'available', IsFee: false, Reason: null })),
  )

const refused = (Code: string): DnaFail => ({ result: 'ERROR', error: { Code, Message: Code } })

function supplier(check: Check = async (names, tlds) => available(names, tlds)) {
  const spy = vi.fn<Check>(check)
  const client = { CheckAvailability: spy } as unknown as DomainNameApi
  return { check: spy, client: () => client }
}

const fresh = () => ({
  bucket: new TokenBucket(100, 100),
  bulkBucket: new TokenBucket(100, 100),
  cache: new TtlCache<AvailabilityStatus>(60_000, 1000),
  slots: new Semaphore(2),
  backoff: () => 0,
})

function appWith(deps: Parameters<typeof createAvailabilityRoute>[0]) {
  return createApp({ availability: createAvailabilityRoute(deps) })
}

async function post(app: ReturnType<typeof createApp>, body: unknown, secret = SECRET) {
  const response = await app.request('/v1/availability', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await response.json()) as { ok: boolean; data?: Results; code?: string }
  return { status: response.status, json }
}

const statuses = (json: { data?: Results }) => json.data?.results.map((r) => r.status)

describe('POST /v1/availability — refusals', () => {
  let deps: ReturnType<typeof fresh>
  beforeEach(() => {
    deps = fresh()
  })

  it('refuses a caller without the shared secret', async () => {
    const { check, client } = supplier()
    const app = appWith({ ...deps, client })
    const { status } = await post(
      app,
      { names: ['getpaid'], tlds: ['com'] },
      'wrong-secret-value-xx',
    )
    expect(status).toBe(401)
    expect(check).not.toHaveBeenCalled()
  })

  it('refuses a malformed request without calling the supplier', async () => {
    const { check, client } = supplier()
    const { status, json } = await post(appWith({ ...deps, client }), {
      names: ['get paid'],
      tlds: ['com'],
    })
    expect(status).toBe(400)
    expect(json.code).toBe('VALIDATION_FAILED')
    expect(check).not.toHaveBeenCalled()
  })

  it('refuses rather than queues when the rate limit is spent', async () => {
    const { check, client } = supplier()
    const bucket = new TokenBucket(1, 0)
    const { status, json } = await post(appWith({ ...deps, client, bucket }), {
      names: ['getpaid'],
      tlds: ['com', 'net', 'org'],
    })
    expect(status).toBe(429)
    expect(json).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    expect(check).not.toHaveBeenCalled()
  })

  it('reports an outage, not a page of unknowns, when every call fails', async () => {
    const { client } = supplier(async () => refused('CREDENTIALS'))
    const { status, json } = await post(appWith({ ...deps, client }), {
      names: ['getpaid'],
      tlds: ['com', 'net'],
    })
    expect(status).toBe(502)
    expect(json).toMatchObject({ ok: false, code: 'SUPPLIER_AUTH', retryable: false })
  })
})

describe('POST /v1/availability — the supplier ceiling (PRD V4)', () => {
  let deps: ReturnType<typeof fresh>
  beforeEach(() => {
    deps = fresh()
  })

  it('splits the extensions into two batches, one per supplier slot', async () => {
    const { check, client } = supplier()
    const { json } = await post(appWith({ ...deps, client }), {
      names: ['getpaid', 'trygetpaid'],
      tlds: ['com', 'africa', 'co'],
    })
    expect(check).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenCalledWith(['getpaid', 'trygetpaid'], ['com', 'co'], 1)
    expect(check).toHaveBeenCalledWith(['getpaid', 'trygetpaid'], ['africa'], 1)
    expect(statuses(json)).toEqual(Array(6).fill('available'))
  })

  it('never asks the supplier more than 20 checks in one call — it refuses a 21st with 403', async () => {
    const { check, client } = supplier(async (names, tlds) =>
      names.length * tlds.length > 20 ? refused('API_403') : available(names, tlds),
    )
    const names = Array.from({ length: 25 }, (_, i) => `name${i}`)
    const { json } = await post(appWith({ ...deps, client }), { names, tlds: ['com'] })
    expect(check.mock.calls.map(([asked, tlds]) => asked.length * tlds.length)).toEqual([20, 5])
    expect(statuses(json)).toEqual(Array(25).fill('available'))
  })

  it('packs names to the 20-check ceiling on every extension group', async () => {
    const { check, client } = supplier()
    const names = Array.from({ length: 12 }, (_, i) => `name${i}`)
    await post(appWith({ ...deps, client }), { names, tlds: ['com', 'net', 'org', 'io'] })
    for (const [asked, tlds] of check.mock.calls) {
      expect(asked.length * tlds.length).toBeLessThanOrEqual(20)
    }
    // Two extensions per group: 10 names a call, so 12 names take two calls a group.
    expect(check).toHaveBeenCalledTimes(4)
  })

  it('never has more than two supplier calls in flight, across concurrent searches', async () => {
    let inFlight = 0
    let peak = 0
    const { client } = supplier(async (names, tlds) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return available(names, tlds)
    })
    const app = appWith({ ...deps, client })

    await Promise.all([
      post(app, { names: ['one'], tlds: ['com', 'net', 'org'] }),
      post(app, { names: ['two'], tlds: ['com', 'net'] }),
      post(app, { names: ['three'], tlds: ['africa'] }),
    ])
    expect(peak).toBe(2)
  })

  it('retries a call the supplier refused as rate limited', async () => {
    let calls = 0
    const { client } = supplier(async (names, tlds) => {
      calls += 1
      return calls === 1 ? refused('API_429') : available(names, tlds)
    })
    const { json } = await post(appWith({ ...deps, client }), { names: ['getpaid'], tlds: ['com'] })
    expect(calls).toBe(2)
    expect(statuses(json)).toEqual(['available'])
  })

  it('gives up after two retries rather than hammering the supplier', async () => {
    const { check, client } = supplier(async () => refused('API_429'))
    const { status, json } = await post(appWith({ ...deps, client }), {
      names: ['getpaid'],
      tlds: ['com'],
    })
    expect(check).toHaveBeenCalledTimes(3)
    expect(status).toBe(502)
    expect(json).toMatchObject({ code: 'SUPPLIER_UNAVAILABLE', retryable: true })
  })

  it('gives up on a call that waits too long for a slot', async () => {
    const slots = new Semaphore(1)
    let release: () => void = () => {}
    const blocker = slots.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const { check, client } = supplier()

    const { status } = await post(appWith({ ...deps, client, slots, queueWaitMs: 10 }), {
      names: ['getpaid'],
      tlds: ['com'],
    })
    release()
    await blocker

    expect(status).toBe(502)
    expect(check).not.toHaveBeenCalled()
  })
})

describe('POST /v1/availability — answers', () => {
  let deps: ReturnType<typeof fresh>
  beforeEach(() => {
    deps = fresh()
  })

  it('answers every pair, in name then extension order', async () => {
    const { client } = supplier()
    const { json } = await post(appWith({ ...deps, client }), {
      names: ['a1', 'b2'],
      tlds: ['com', 'net'],
    })
    expect(json.data?.results.map((r) => r.domain)).toEqual([
      'a1.com',
      'a1.net',
      'b2.com',
      'b2.net',
    ])
  })

  it('classifies taken, premium and restricted names', async () => {
    const { client } = supplier(async (names, tlds) =>
      names.map((DomainName) => ({
        DomainName,
        TLD: tlds[0] ?? '',
        Status: DomainName === 'open' ? 'available' : 'notavailable',
        IsFee: DomainName === 'hotel',
        Reason:
          DomainName === 'google'
            ? 'Domain exists'
            : DomainName === 'x'
              ? 'must contain at least 3'
              : null,
      })),
    )
    const { json } = await post(appWith({ ...deps, client }), {
      names: ['open', 'google', 'hotel', 'x'],
      tlds: ['com'],
    })
    expect(statuses(json)).toEqual(['available', 'registered', 'premium', 'restricted'])
  })

  it('answers a repeat search from cache for 60 seconds (FR-S6)', async () => {
    const { check, client } = supplier()
    const app = appWith({ ...deps, client })
    await post(app, { names: ['getpaid'], tlds: ['com'] })
    await post(app, { names: ['getpaid'], tlds: ['com'] })
    expect(check).toHaveBeenCalledOnce()
  })

  it('asks the supplier only about what the cache cannot answer', async () => {
    const { check, client } = supplier()
    const app = appWith({ ...deps, client })
    await post(app, { names: ['getpaid'], tlds: ['com'] })
    await post(app, { names: ['getpaid', 'newname'], tlds: ['com'] })
    expect(check).toHaveBeenLastCalledWith(['newname'], ['com'], 1)
  })

  it('spends no rate limit on a search answered entirely from cache', async () => {
    const { client } = supplier()
    const app = appWith({ ...deps, client, bucket: new TokenBucket(1, 0) })
    await post(app, { names: ['getpaid'], tlds: ['com'] })
    const { status } = await post(app, { names: ['getpaid'], tlds: ['com'] })
    expect(status).toBe(200)
  })

  it('marks one batch unknown when only its call fails, and never caches that', async () => {
    const { check, client } = supplier(async (names, tlds) =>
      tlds.includes('app') ? refused('SOMETHING') : available(names, tlds),
    )
    const app = appWith({ ...deps, client })
    const { status, json } = await post(app, { names: ['getpaid'], tlds: ['com', 'app'] })

    expect(status).toBe(200)
    expect(statuses(json)).toEqual(['available', 'unknown'])

    await post(app, { names: ['getpaid'], tlds: ['com', 'app'] })
    expect(check).toHaveBeenLastCalledWith(['getpaid'], ['app'], 1)
  })

  it('treats a supplier that hangs as unknown after the timeout', async () => {
    const { client } = supplier((names, tlds) =>
      tlds.includes('app') ? new Promise(() => {}) : Promise.resolve(available(names, tlds)),
    )
    const { json } = await post(appWith({ ...deps, client, timeoutMs: 20 }), {
      names: ['getpaid'],
      tlds: ['com', 'app'],
    })
    expect(statuses(json)).toEqual(['available', 'unknown'])
  })

  it('treats a supplier that throws as unknown', async () => {
    const { client } = supplier(async (names, tlds) => {
      if (tlds.includes('app')) throw new Error('socket hang up')
      return available(names, tlds)
    })
    const { json } = await post(appWith({ ...deps, client }), {
      names: ['getpaid'],
      tlds: ['com', 'app'],
    })
    expect(statuses(json)).toEqual(['available', 'unknown'])
  })

  it('ignores rows for extensions it did not ask about', async () => {
    const { client } = supplier(async (names) => available(names, ['net']))
    const { json } = await post(appWith({ ...deps, client }), { names: ['getpaid'], tlds: ['com'] })
    expect(statuses(json)).toEqual(['unknown'])
  })
})

describe('POST /v1/availability — bulk search, low priority (FR-S5)', () => {
  let deps: ReturnType<typeof fresh>
  beforeEach(() => {
    deps = fresh()
  })

  it('refuses bulk when its own limit is spent, and still answers a single search', async () => {
    const { check, client } = supplier()
    const app = appWith({ ...deps, client, bulkBucket: new TokenBucket(1, 0) })

    const bulk = await post(app, {
      names: ['bulkone', 'bulktwo'],
      tlds: ['com', 'net'],
      priority: 'low',
    })
    expect(bulk.status).toBe(429)
    expect(bulk.json).toMatchObject({ code: 'RATE_LIMITED' })
    expect(check).not.toHaveBeenCalled()

    const single = await post(app, { names: ['getpaid'], tlds: ['com', 'net'] })
    expect(single.status).toBe(200)
  })

  it('never spends the tokens single searches need', async () => {
    const { client } = supplier()
    const bucket = new TokenBucket(2, 0)
    const app = appWith({ ...deps, client, bucket })

    await post(app, { names: ['bulkone'], tlds: ['com', 'net'], priority: 'low' })
    expect(bucket.availableTokens()).toBe(2)
  })

  it('leaves one supplier slot free for single searches while a bulk call runs', async () => {
    const gate: { open: () => void } = { open: () => {} }
    const opened = new Promise<void>((resolve) => {
      gate.open = resolve
    })
    const seen: string[] = []
    const { client } = supplier(async (names, tlds) => {
      seen.push(names[0] ?? '')
      if (names[0] === 'bulkone') await opened
      return available(names, tlds)
    })
    const app = appWith({ ...deps, client, slots: new Semaphore(2, 1) })

    // Two bulk requests would take both slots if nothing held them back.
    const bulkA = post(app, { names: ['bulkone'], tlds: ['com'], priority: 'low' })
    const bulkB = post(app, { names: ['bulktwo'], tlds: ['com'], priority: 'low' })
    const single = await post(app, { names: ['getpaid'], tlds: ['com'] })

    expect(single.status).toBe(200)
    expect(seen).toEqual(['bulkone', 'getpaid'])
    gate.open()
    await Promise.all([bulkA, bulkB])
    expect(seen).toEqual(['bulkone', 'getpaid', 'bulktwo'])
  })

  it('waits longer for its turn than a single search would', async () => {
    const slots = new Semaphore(1)
    let release: () => void = () => {}
    const blocker = slots.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const { check, client } = supplier()
    const app = appWith({ ...deps, client, slots, queueWaitMs: 5, lowQueueWaitMs: 1_000 })

    const bulk = post(app, { names: ['bulkone'], tlds: ['com'], priority: 'low' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await blocker

    expect((await bulk).status).toBe(200)
    expect(check).toHaveBeenCalledOnce()
  })
})

describe('POST /v1/availability — re-validation (FR-S6)', () => {
  let deps: ReturnType<typeof fresh>
  beforeEach(() => {
    deps = fresh()
  })

  it('asks the supplier again when told to, and keeps the new answer', async () => {
    let taken = false
    const { check, client } = supplier(async (names, tlds) =>
      available(names, tlds).map((row) =>
        taken ? { ...row, Status: 'notavailable', Reason: 'Domain exists' } : row,
      ),
    )
    const app = appWith({ ...deps, client })
    await post(app, { names: ['getpaid'], tlds: ['com'] })
    taken = true

    const cachedAnswer = await post(app, { names: ['getpaid'], tlds: ['com'] })
    expect(statuses(cachedAnswer.json)).toEqual(['available'])
    expect(check).toHaveBeenCalledOnce()

    const freshAnswer = await post(app, { names: ['getpaid'], tlds: ['com'], fresh: true })
    expect(statuses(freshAnswer.json)).toEqual(['registered'])
    expect(check).toHaveBeenCalledTimes(2)

    const after = await post(app, { names: ['getpaid'], tlds: ['com'] })
    expect(statuses(after.json)).toEqual(['registered'])
  })

  it('reports unknown rather than the old answer when a fresh call fails', async () => {
    let failing = false
    const { client } = supplier(async (names, tlds) =>
      failing && tlds.includes('app') ? refused('SOMETHING') : available(names, tlds),
    )
    const app = appWith({ ...deps, client })
    await post(app, { names: ['getpaid'], tlds: ['com', 'app'] })
    failing = true

    const { json } = await post(app, { names: ['getpaid'], tlds: ['com', 'app'], fresh: true })
    expect(statuses(json)).toEqual(['available', 'unknown'])
  })
})

describe('toCalls', () => {
  it('keeps one call per extension group while it fits', () => {
    expect(toCalls(['getpaid'], ['com', 'net', 'org'], 2)).toEqual([
      { names: ['getpaid'], tlds: ['com', 'org'] },
      { names: ['getpaid'], tlds: ['net'] },
    ])
  })

  it('splits the names of a group so no call passes the ceiling', () => {
    const names = Array.from({ length: 7 }, (_, i) => `n${i}`)
    expect(toCalls(names, ['com', 'net', 'org'], 1, 6)).toEqual([
      { names: ['n0', 'n1'], tlds: ['com', 'net', 'org'] },
      { names: ['n2', 'n3'], tlds: ['com', 'net', 'org'] },
      { names: ['n4', 'n5'], tlds: ['com', 'net', 'org'] },
      { names: ['n6'], tlds: ['com', 'net', 'org'] },
    ])
  })

  it('splits a group wider than the ceiling, one name at a time', () => {
    expect(toCalls(['a'], ['com', 'net', 'org'], 1, 2)).toEqual([
      { names: ['a'], tlds: ['com', 'net'] },
      { names: ['a'], tlds: ['org'] },
    ])
  })
})

describe('toBatches', () => {
  it('deals extensions round-robin so the first stays in the first batch', () => {
    expect(toBatches(['com', 'net', 'org', 'africa', 'co'], 2)).toEqual([
      ['com', 'org', 'co'],
      ['net', 'africa'],
    ])
  })

  it('never makes an empty batch', () => {
    expect(toBatches(['com'], 2)).toEqual([['com']])
    expect(toBatches([], 2)).toEqual([])
  })
})
