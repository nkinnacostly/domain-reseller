import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normaliseHost } from '../delegation/resolvers'
import type { Env } from '../env'
import { type AddressLookup, type AddressView, createAddressLookup } from './resolvers'
import {
  createPresetStore,
  type DuePreset,
  type HostCheck,
  type PresetCheckDetail,
  type PresetOutcome,
  type PresetStore,
} from './store'

/**
 * Host presets checked in public DNS (PRD FR-D2): "a preset whose
 * nameservers stop resolving is flagged in admin and hidden from customers
 * automatically". A stale preset points every customer who picks it at dead
 * nameservers (PRD R8b), so each preset's hosts are looked up on a schedule
 * and the verdict recorded; the database hides a preset after a day of
 * failures and shows it again after one pass, and the alert monitor tells a
 * person either way.
 *
 * A check we could not make is not a failure: when the resolvers do not
 * answer, nothing is recorded, so our own network trouble never hides a
 * preset. Read-only everywhere but `nameserver_presets`; never calls the
 * supplier.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

/**
 * A host passes when every resolver that answered found an address for it.
 * Resolvers that could not be asked have no say; if none could, the host is
 * unanswered.
 */
export function judgeHost(views: AddressView[]): HostCheck['verdict'] {
  const answered = views.filter((view) => view.state !== 'no-answer')
  if (answered.length === 0) return 'unanswered'
  return answered.every((view) => view.state === 'resolves') ? 'resolves' : 'fails'
}

/**
 * The preset's verdict: one host that fails fails it — a customer pointed
 * at it gets a nameserver that does not exist — whatever the others say.
 * Without a failure, one unanswered host leaves the check inconclusive.
 */
export function judgePreset(hosts: HostCheck[]): 'pass' | 'fail' | 'inconclusive' {
  if (hosts.length === 0) return 'inconclusive'
  if (hosts.some((host) => host.verdict === 'fails')) return 'fail'
  if (hosts.some((host) => host.verdict === 'unanswered')) return 'inconclusive'
  return 'pass'
}

export type PresetRun = { checked: number; inconclusive: number } & Record<PresetOutcome, number>

export type PresetCheckerOptions = {
  store: PresetStore
  lookup: AddressLookup
  everyMs: number
  log: Log
}

export function createPresetChecker(options: PresetCheckerOptions) {
  const { store, lookup, everyMs, log } = options

  async function inspect(preset: DuePreset): Promise<HostCheck[]> {
    const hosts = [...new Set(preset.nameservers.map(normaliseHost).filter(Boolean))]
    return Promise.all(
      hosts.map(async (host) => {
        const views = await lookup(host)
        return { host, verdict: judgeHost(views), views }
      }),
    )
  }

  /** One pass over every preset due a check. Presets one at a time; a preset's hosts together. */
  async function runOnce(): Promise<PresetRun> {
    const run: PresetRun = {
      checked: 0,
      inconclusive: 0,
      ok: 0,
      failing: 0,
      hidden: 0,
      restored: 0,
    }

    for (const preset of await store.due()) {
      const hosts = await inspect(preset)
      const verdict = judgePreset(hosts)
      const about = { presetId: preset.id, provider: preset.provider }

      if (verdict === 'inconclusive') {
        run.inconclusive += 1
        log.warn(
          {
            ...about,
            unanswered: hosts.filter((host) => host.verdict === 'unanswered').map((h) => h.host),
          },
          'preset check inconclusive: the resolvers did not answer, nothing recorded',
        )
        continue
      }

      const unresolved = hosts.filter((host) => host.verdict === 'fails').map((host) => host.host)
      const detail: PresetCheckDetail = { unresolved, hosts }
      const outcome = await store.record(preset.id, verdict === 'pass', detail)
      run.checked += 1
      run[outcome] += 1

      if (outcome === 'hidden') {
        log.warn({ ...about, unresolved }, 'preset hidden from customers: a day of failed checks')
      } else if (outcome === 'failing') {
        log.warn({ ...about, unresolved }, 'preset failing: its nameservers do not resolve')
      } else if (outcome === 'restored') {
        log.info(about, 'preset shown to customers again: its nameservers resolve')
      }
    }

    if (run.checked > 0 || run.inconclusive > 0) log.info(run, 'preset check finished')
    return run
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    try {
      await runOnce()
    } catch (error) {
      log.error({ err: error }, 'preset check failed')
    }
    if (!running) return
    timer = setTimeout(() => {
      current = cycle()
    }, everyMs)
  }

  return {
    runOnce,
    start() {
      if (running) return
      running = true
      current = cycle()
    },
    async stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      await current
    },
  }
}

/**
 * The gateway's preset check, or null where it must not run — the same
 * place as the delegation check. Presets are shared by both sides, and
 * hiding one changes what live customers see, so only the gateway that
 * registers on the live registry (a production deployment, per env.ts)
 * checks them; its alert monitor is the one that reports preset alerts.
 */
export function presetCheckerFor(
  env: Env,
  log: Log,
  /** Test seams: the network boundaries. */
  deps: { client?: SupabaseClient<Database>; fetchImpl?: typeof fetch } = {},
) {
  if (env.DNA_WRITE_ENV !== 'production') return null
  const client =
    deps.client ??
    createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  return createPresetChecker({
    store: createPresetStore(client),
    lookup: createAddressLookup(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    everyMs: env.PRESET_CHECK_HOURS * 3_600_000,
    log,
  })
}
