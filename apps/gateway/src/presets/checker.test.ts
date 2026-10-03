import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../env'
import { createPresetChecker, judgeHost, judgePreset, presetCheckerFor } from './checker'
import type { AddressView } from './resolvers'
import type { DuePreset, PresetCheckDetail, PresetOutcome, PresetStore } from './store'

/**
 * The preset check (FR-D2): which verdict each preset gets, what is recorded,
 * and when nothing is. The DNS lookup and the store are fakes.
 */

const resolves = (resolver: string): AddressView => ({
  resolver,
  state: 'resolves',
  addresses: ['192.0.2.1'],
})
const OK: AddressView[] = [resolves('Cloudflare'), resolves('Google')]
const GONE: AddressView[] = [
  { resolver: 'Cloudflare', state: 'nxdomain' },
  { resolver: 'Google', state: 'nxdomain' },
]
const SILENT: AddressView[] = [
  { resolver: 'Cloudflare', state: 'no-answer' },
  { resolver: 'Google', state: 'no-answer' },
]

const preset = (id: string, nameservers = [`ns1.${id}.test`, `ns2.${id}.test`]): DuePreset => ({
  id,
  provider: `Host ${id}`,
  nameservers,
})

/** Answers per host; any host not listed resolves everywhere. */
const seeing =
  (byHost: Record<string, AddressView[]>) =>
  async (host: string): Promise<AddressView[]> =>
    byHost[host] ?? OK

function fakeStore(presets: DuePreset[], outcomes: Record<string, PresetOutcome> = {}) {
  const recorded: { id: string; ok: boolean; detail: PresetCheckDetail }[] = []
  const store = {
    due: vi.fn(async () => presets),
    record: vi.fn(async (id: string, ok: boolean, detail: PresetCheckDetail) => {
      recorded.push({ id, ok, detail })
      return outcomes[id] ?? (ok ? 'ok' : 'failing')
    }),
  } satisfies PresetStore
  return { store, recorded }
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

function checker(store: PresetStore, lookup = seeing({})) {
  const logger = log()
  const instance = createPresetChecker({ store, lookup, everyMs: 6 * 3_600_000, log: logger })
  return { instance, logger }
}

describe('judging one host', () => {
  it('passes a host every answering resolver finds an address for', () => {
    expect(judgeHost(OK)).toBe('resolves')
    expect(judgeHost([resolves('Cloudflare'), { resolver: 'Google', state: 'no-answer' }])).toBe(
      'resolves',
    )
  })

  it('fails a host that a resolver says does not exist or has no address', () => {
    expect(judgeHost(GONE)).toBe('fails')
    expect(judgeHost([resolves('Cloudflare'), { resolver: 'Google', state: 'nxdomain' }])).toBe(
      'fails',
    )
    expect(
      judgeHost([
        { resolver: 'Cloudflare', state: 'no-address' },
        { resolver: 'Google', state: 'no-answer' },
      ]),
    ).toBe('fails')
    expect(judgeHost([{ resolver: 'Google', state: 'servfail' }])).toBe('fails')
  })

  it('leaves a host no resolver answered for undecided', () => {
    expect(judgeHost(SILENT)).toBe('unanswered')
    expect(judgeHost([])).toBe('unanswered')
  })
})

describe('judging a preset', () => {
  const host = (verdict: 'resolves' | 'fails' | 'unanswered') => ({
    host: 'ns.test',
    verdict,
    views: [],
  })

  it('passes only when every host resolves', () => {
    expect(judgePreset([host('resolves'), host('resolves')])).toBe('pass')
  })

  it('fails on one failing host, even when another could not be asked', () => {
    expect(judgePreset([host('resolves'), host('fails')])).toBe('fail')
    expect(judgePreset([host('unanswered'), host('fails')])).toBe('fail')
  })

  it('decides nothing when a host went unanswered and none failed', () => {
    expect(judgePreset([host('resolves'), host('unanswered')])).toBe('inconclusive')
    expect(judgePreset([])).toBe('inconclusive')
  })
})

describe('the preset checker', () => {
  it('records a pass for a preset whose nameservers all resolve', async () => {
    const { store, recorded } = fakeStore([preset('vercel')])
    const { instance, logger } = checker(store)
    await expect(instance.runOnce()).resolves.toEqual({
      checked: 1,
      inconclusive: 0,
      drafts: 0,
      ok: 1,
      failing: 0,
      hidden: 0,
      restored: 0,
    })
    expect(recorded).toEqual([
      {
        id: 'vercel',
        ok: true,
        detail: {
          unresolved: [],
          hosts: [
            { host: 'ns1.vercel.test', verdict: 'resolves', views: OK },
            { host: 'ns2.vercel.test', verdict: 'resolves', views: OK },
          ],
        },
      },
    ])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('records a failure for a preset whose nameservers no longer exist', async () => {
    const { store, recorded } = fakeStore([preset('gone')])
    const { instance, logger } = checker(
      store,
      seeing({ 'ns1.gone.test': GONE, 'ns2.gone.test': GONE }),
    )
    await expect(instance.runOnce()).resolves.toMatchObject({ checked: 1, failing: 1 })
    expect(recorded[0]).toMatchObject({
      id: 'gone',
      ok: false,
      detail: { unresolved: ['ns1.gone.test', 'ns2.gone.test'] },
    })
    expect(logger.warn).toHaveBeenCalledWith(
      { presetId: 'gone', provider: 'Host gone', unresolved: ['ns1.gone.test', 'ns2.gone.test'] },
      'preset failing: its nameservers do not resolve',
    )
  })

  it('fails a preset when one of its nameservers stops resolving', async () => {
    const { store, recorded } = fakeStore([preset('half')])
    const { instance } = checker(store, seeing({ 'ns2.half.test': GONE }))
    await instance.runOnce()
    expect(recorded[0]?.ok).toBe(false)
    expect(recorded[0]?.detail.unresolved).toEqual(['ns2.half.test'])
    expect(recorded[0]?.detail.hosts.map((host) => host.verdict)).toEqual(['resolves', 'fails'])
  })

  it('records nothing when the resolvers did not answer — our network is not the preset’s fault', async () => {
    const { store, recorded } = fakeStore([preset('quiet')])
    const { instance, logger } = checker(
      store,
      seeing({ 'ns1.quiet.test': SILENT, 'ns2.quiet.test': SILENT }),
    )
    await expect(instance.runOnce()).resolves.toMatchObject({ checked: 0, inconclusive: 1 })
    expect(recorded).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      {
        presetId: 'quiet',
        provider: 'Host quiet',
        unanswered: ['ns1.quiet.test', 'ns2.quiet.test'],
      },
      'preset check inconclusive: the resolvers did not answer, nothing recorded',
    )
  })

  it('passes a host one resolver answered for when the other timed out', async () => {
    const half: AddressView[] = [resolves('Cloudflare'), { resolver: 'Google', state: 'no-answer' }]
    const { store, recorded } = fakeStore([preset('mixed')])
    const { instance } = checker(store, seeing({ 'ns1.mixed.test': half, 'ns2.mixed.test': half }))
    await instance.runOnce()
    expect(recorded[0]?.ok).toBe(true)
  })

  it('records nothing for a preset with one host unanswered and the rest resolving', async () => {
    const { store, recorded } = fakeStore([preset('partial')])
    const { instance } = checker(store, seeing({ 'ns2.partial.test': SILENT }))
    await expect(instance.runOnce()).resolves.toMatchObject({ inconclusive: 1 })
    expect(recorded).toEqual([])
  })

  it('checks each distinct host once, however it is written', async () => {
    const lookup = vi.fn(seeing({}))
    const { store } = fakeStore([preset('dup', ['NS1.Dup.Test.', 'ns1.dup.test', ' '])])
    const { instance } = checker(store, lookup)
    await instance.runOnce()
    expect(lookup.mock.calls).toEqual([['ns1.dup.test']])
  })

  it('says when the database hid a preset, and when it showed one again', async () => {
    const { store } = fakeStore([preset('dead'), preset('back')], {
      dead: 'hidden',
      back: 'restored',
    })
    const { instance, logger } = checker(store, seeing({ 'ns1.dead.test': GONE }))
    await expect(instance.runOnce()).resolves.toMatchObject({
      checked: 2,
      hidden: 1,
      restored: 1,
    })
    expect(logger.warn).toHaveBeenCalledWith(
      { presetId: 'dead', provider: 'Host dead', unresolved: ['ns1.dead.test'] },
      'preset hidden from customers: a day of failed checks',
    )
    expect(logger.info).toHaveBeenCalledWith(
      { presetId: 'back', provider: 'Host back' },
      'preset shown to customers again: its nameservers resolve',
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ checked: 2 }),
      'preset check finished',
    )
  })

  it('says nothing when no preset is due', async () => {
    const { store } = fakeStore([])
    const { instance, logger } = checker(store)
    await expect(instance.runOnce()).resolves.toMatchObject({ checked: 0, inconclusive: 0 })
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('logs a failed run and carries on at the next interval', async () => {
    vi.useFakeTimers()
    try {
      const { store } = fakeStore([preset('a')])
      store.due.mockRejectedValueOnce(new Error('database down'))
      const { instance, logger } = checker(store)
      instance.start()
      instance.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'preset check failed')
      await vi.advanceTimersByTimeAsync(6 * 3_600_000)
      expect(store.record).toHaveBeenCalledTimes(1)
      await instance.stop()
      await vi.advanceTimersByTimeAsync(24 * 3_600_000)
      expect(store.due).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops cleanly when stopped mid-run', async () => {
    const { store, recorded } = fakeStore([preset('a')])
    const { instance } = checker(store)
    instance.start()
    await instance.stop()
    expect(recorded).toHaveLength(1)
  })
})

describe('where the preset check runs', () => {
  const BASE = {
    GATEWAY_SHARED_SECRET: 'test-secret-value-at-least-16',
    DNA_RESELLER_ID: '00000000-0000-0000-0000-000000000000',
    DNA_API_KEY: 'x',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SECRET_KEY: 'x',
  }
  const flw = (key: string) => ({ FLUTTERWAVE_SECRET_KEY: key })

  it('not on a gateway without live registrations: a laptop, the sandbox, or writes off', () => {
    expect(presetCheckerFor(parseEnv(BASE), log())).toBeNull()
    expect(
      presetCheckerFor(
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
    expect(presetCheckerFor(LIVE, log())).not.toBeNull()
  })

  it('checks presets end to end: due list, resolvers, record', async () => {
    const rpcs: { fn: string; args: unknown }[] = []
    const client = {
      rpc: async (fn: string, args: unknown) => {
        rpcs.push({ fn, args })
        if (fn === 'presets_for_check') {
          return {
            data: [{ preset_id: 'p1', provider: 'Vercel', nameservers: ['ns1.vercel-dns.com'] }],
            error: null,
          }
        }
        return { data: 'ok', error: null }
      },
    }
    const fetchImpl = vi.fn(async (url: URL | string) =>
      new URL(String(url)).searchParams.get('type') === 'A'
        ? Response.json({
            Status: 0,
            Answer: [{ name: 'ns1.vercel-dns.com.', type: 1, data: '216.150.1.1' }],
          })
        : Response.json({ Status: 0 }),
    )
    const created = presetCheckerFor(LIVE, log(), {
      client: client as never,
      fetchImpl: fetchImpl as never,
    })
    await expect(created?.runOnce()).resolves.toMatchObject({ checked: 1, ok: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(rpcs.map((call) => call.fn)).toEqual([
      'presets_for_check',
      'record_preset_check',
      'preset_drafts_for_check',
    ])
    expect(rpcs[1]?.args).toMatchObject({ p_preset_id: 'p1', p_ok: true })
  })
})

describe('preset drafts (ADMIN-SPEC D21)', () => {
  function draftStore(drafts: DuePreset[]) {
    const recorded: { id: string; ok: boolean }[] = []
    const { store } = fakeStore([])
    return {
      store: {
        ...store,
        dueDrafts: vi.fn(async () => drafts),
        recordDraft: vi.fn(async (id: string, ok: boolean) => {
          recorded.push({ id, ok })
          return ok ? ('ok' as const) : ('failing' as const)
        }),
      },
      recorded,
    }
  }

  it('checks open drafts on the periodic pass, recording only on the draft', async () => {
    const { store, recorded } = draftStore([preset('draft-ok'), preset('draft-gone')])
    const { instance, logger } = checker(
      store,
      seeing({ 'ns1.draft-gone.test': GONE, 'ns2.draft-gone.test': GONE }),
    )
    await expect(instance.runOnce()).resolves.toMatchObject({ checked: 0, drafts: 2 })
    expect(recorded).toEqual([
      { id: 'draft-ok', ok: true },
      { id: 'draft-gone', ok: false },
    ])
    expect(store.record).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ drafts: 2 }),
      'preset check finished',
    )
  })

  it('checks a draft on demand, and records nothing when the resolvers were silent', async () => {
    const { store, recorded } = draftStore([])
    const { instance } = checker(
      store,
      seeing({ 'ns1.quiet.test': SILENT, 'ns2.quiet.test': SILENT }),
    )
    const quiet = await instance.checkDraft(preset('quiet'))
    expect(quiet.verdict).toBe('inconclusive')
    expect(recorded).toEqual([])
    const fine = await instance.checkDraft(preset('fine'))
    expect(fine.verdict).toBe('pass')
    expect(fine.hosts.map((host) => host.host)).toEqual(['ns1.fine.test', 'ns2.fine.test'])
    expect(recorded).toEqual([{ id: 'fine', ok: true }])
  })

  it('counts a silent draft on the periodic pass as inconclusive', async () => {
    const { store } = draftStore([preset('quiet')])
    const { instance } = checker(
      store,
      seeing({ 'ns1.quiet.test': SILENT, 'ns2.quiet.test': SILENT }),
    )
    await expect(instance.runOnce()).resolves.toMatchObject({ drafts: 0, inconclusive: 1 })
  })
})
