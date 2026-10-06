import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailClient } from '../store'
import type { Reading } from './cloudwatch'
import {
  createApplyPing,
  createSafetyJob,
  createSafetyStore,
  SAFETY_HEARTBEAT,
  type SafetyStore,
} from './job'

/**
 * The worker's safety run (MAIL-SPEC §7.4, §7.8): read CloudWatch, let SQL
 * judge every account, ping apps/mail while SES changes wait, and beat.
 */

const log = { info: vi.fn(), warn: vi.fn() }

function store(answer = { evaluated: 3, paused: 0, openWarnings: 1, pendingTenantActions: 0 }) {
  const runs: Reading[] = []
  const beats: unknown[] = []
  const fake: SafetyStore = {
    run: vi.fn(async (reading: Reading) => {
      runs.push(reading)
      return answer
    }),
    heartbeat: vi.fn(async (detail) => {
      beats.push(detail)
    }),
  }
  return { fake, runs, beats }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('a run', () => {
  it('records the reading, judges the accounts and beats, saying it beats every 15 minutes', async () => {
    const { fake, runs, beats } = store()
    const ping = vi.fn(async () => 'ok' as const)
    const reading: Reading = {
      outcome: 'ok',
      bouncePpm: 12_000,
      complaintPpm: 300,
      metricAt: '2026-10-06T11:45:00.000Z',
    }
    const job = createSafetyJob({
      read: async () => reading,
      store: fake,
      ping,
      everyMs: 15 * 60_000,
      log,
    })
    const run = await job.check()
    expect(runs).toEqual([reading])
    expect(ping).not.toHaveBeenCalled()
    expect(run).toEqual({
      reading: 'ok',
      evaluated: 3,
      paused: 0,
      openWarnings: 1,
      pendingTenantActions: 0,
      pinged: 'not_needed',
    })
    expect(beats).toEqual([
      {
        everyMinutes: 15,
        reading: 'ok',
        evaluated: 3,
        paused: 0,
        openWarnings: 1,
        pendingTenantActions: 0,
        pinged: 'not_needed',
      },
    ])
  })

  it('pings apps/mail while SES changes wait, and says so when it could not', async () => {
    const { fake } = store({ evaluated: 2, paused: 1, openWarnings: 0, pendingTenantActions: 1 })
    const ping = vi.fn(async () => 'failed' as const)
    const job = createSafetyJob({
      read: async () => ({ outcome: 'no_data' }),
      store: fake,
      ping,
      everyMs: 900_000,
      log,
    })
    const run = await job.check()
    expect(ping).toHaveBeenCalledTimes(1)
    expect(run.pinged).toBe('failed')
    expect(log.warn).toHaveBeenCalledWith(
      { pending: 1, pinged: 'failed' },
      'SES pauses wait for apps/mail to apply them',
    )
    expect(log.warn).toHaveBeenCalledWith({ paused: 1 }, 'accounts paused by our threshold')
  })

  it('still judges the accounts when CloudWatch cannot be read, or throws', async () => {
    const { fake, runs } = store()
    const failed: Reading = { outcome: 'failed', status: 403, code: 'AccessDenied' }
    await createSafetyJob({
      read: async () => failed,
      store: fake,
      ping: vi.fn(),
      everyMs: 900_000,
      log,
    }).check()
    await createSafetyJob({
      read: async () => {
        throw new Error('boom')
      },
      store: fake,
      ping: vi.fn(),
      everyMs: 900_000,
      log,
    }).check()
    expect(runs).toEqual([failed, { outcome: 'failed', status: null, code: null }])
    expect(log.warn).toHaveBeenCalledWith(
      { status: 403, code: 'AccessDenied' },
      'CloudWatch reputation not read',
    )
  })

  it('runs on a timer, survives a failed run, and stops', async () => {
    vi.useFakeTimers()
    const failing: SafetyStore = {
      run: vi.fn(async () => {
        throw new Error('run_safety_checks failed (57014)')
      }),
      heartbeat: vi.fn(),
    }
    const job = createSafetyJob({
      read: async () => ({ outcome: 'no_data' }),
      store: failing,
      ping: vi.fn(),
      everyMs: 1_000,
      log,
    })
    job.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(failing.run).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(
      { err: 'run_safety_checks failed (57014)' },
      'safety run failed',
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(failing.run).toHaveBeenCalledTimes(2)
    job.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(failing.run).toHaveBeenCalledTimes(2)
    job.stop()
  })
})

describe('the ping to apps/mail (§7.4)', () => {
  const SECRET = 's'.repeat(40)

  it('posts to /api/safety/apply with the shared secret and nothing else', async () => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
    )
    const ping = createApplyPing({
      appUrl: 'https://emails.mydomainshub.com',
      secret: SECRET,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    expect(await ping()).toBe('ok')
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('https://emails.mydomainshub.com/api/safety/apply')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ authorization: `Bearer ${SECRET}` })
    expect(init?.body).toBeUndefined()
  })

  it('says not_configured without an address or secret, and failed on a refusal or no answer', async () => {
    expect(await createApplyPing({ appUrl: undefined, secret: SECRET })()).toBe('not_configured')
    expect(await createApplyPing({ appUrl: 'https://x.test', secret: undefined })()).toBe(
      'not_configured',
    )
    const refused = vi.fn(async () => new Response('', { status: 401 }))
    expect(
      await createApplyPing({
        appUrl: 'https://x.test',
        secret: SECRET,
        fetch: refused as unknown as typeof fetch,
      })(),
    ).toBe('failed')
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect(
      await createApplyPing({
        appUrl: 'https://x.test',
        secret: SECRET,
        fetch: down as unknown as typeof fetch,
      })(),
    ).toBe('failed')
  })
})

describe('the store (migration 51)', () => {
  function client(rpc: (fn: string, args: unknown) => { data: unknown; error: unknown }) {
    const calls: { schema: string; fn: string; args: unknown }[] = []
    const at = (schema: string) => ({
      rpc: async (fn: string, args: unknown) => {
        calls.push({ schema, fn, args })
        return rpc(fn, args)
      },
    })
    const fake = { ...at('mail'), schema: (name: string) => at(name) }
    return { fake: fake as unknown as MailClient, calls }
  }

  it('sends an ok reading’s rates, and only the outcome otherwise', async () => {
    const answer = { evaluated: 1, paused: 0, openWarnings: 0, pendingTenantActions: 0 }
    const { fake, calls } = client(() => ({ data: answer, error: null }))
    const s = createSafetyStore(fake)
    expect(
      await s.run({
        outcome: 'ok',
        bouncePpm: 20_000,
        complaintPpm: null,
        metricAt: '2026-10-06T11:45:00.000Z',
      }),
    ).toEqual(answer)
    await s.run({ outcome: 'failed', status: 500, code: null })
    expect(calls).toEqual([
      {
        schema: 'mail',
        fn: 'run_safety_checks',
        args: { p_outcome: 'ok', p_bounce_ppm: 20_000, p_metric_at: '2026-10-06T11:45:00.000Z' },
      },
      { schema: 'mail', fn: 'run_safety_checks', args: { p_outcome: 'failed' } },
    ])
  })

  it('fails loudly on an error or an answer it cannot read', async () => {
    await expect(
      createSafetyStore(client(() => ({ data: null, error: { code: '42501' } })).fake).run({
        outcome: 'no_data',
      }),
    ).rejects.toThrow('run_safety_checks failed (42501)')
    await expect(
      createSafetyStore(client(() => ({ data: { evaluated: -1 }, error: null })).fake).run({
        outcome: 'no_data',
      }),
    ).rejects.toThrow('unexpected shape')
  })

  it('beats as mail-worker:safety on the shop’s heartbeats', async () => {
    const { fake, calls } = client(() => ({ data: null, error: null }))
    await createSafetyStore(fake).heartbeat({ everyMinutes: 15 })
    expect(calls).toEqual([
      {
        schema: 'public',
        fn: 'record_heartbeat',
        args: { p_name: SAFETY_HEARTBEAT, p_test_mode: false, p_detail: { everyMinutes: 15 } },
      },
    ])
    await expect(
      createSafetyStore(client(() => ({ data: null, error: { code: 'x' } })).fake).heartbeat({}),
    ).rejects.toThrow('record_heartbeat failed (x)')
  })
})
