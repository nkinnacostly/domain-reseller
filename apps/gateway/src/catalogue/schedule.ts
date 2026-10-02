import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import type { getJson } from '../lib/http'
import { supplierSlots } from '../lib/semaphore'
import { createPriceRefresh } from './refresh'
import { createCatalogueStore, createRunLog, type LastRun, type RunLog } from './store'
import { createCatalogueSource } from './supplier'
import { type SyncResult, summarise, syncCatalogue } from './sync'

/**
 * The weekly supplier catalogue sync, inside the gateway (N5b).
 *
 * It ran on GitHub's runners until the supplier's IP allowlist: once that is
 * on, only this process's static egress address may call the supplier, so the
 * job lives here. It applies what it finds — the same checks as the CLI,
 * which still reports by default — and leaves each run's outcome in the
 * `catalogue:production` heartbeat, which is also how a restarted gateway
 * knows this week's sync is already done.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

/** What any scheduled sync reports: the domain catalogue's, or the SSL products' (migration 39). */
type Outcome = { outcome: string; reason: string | null }

export type ScheduleResult<R extends Outcome = SyncResult> =
  | { status: 'skipped' }
  | { status: 'failed'; reason: string }
  | { status: 'done'; result: R; pricesRefreshed: boolean | null }

export type CatalogueScheduleOptions<R extends Outcome = SyncResult> = {
  /** One sync that writes what it finds. */
  sync: () => Promise<R>
  /** The counts a log line and the heartbeat carry. Default: the domain catalogue's. */
  summarise?: (result: R) => Record<string, unknown>
  /** What the log calls it. */
  label?: string
  runs: RunLog
  /** How long a successful sync lasts before the next is due. */
  everyMs: number
  /** How often to look whether one is due; cheap, one row read. */
  checkEveryMs?: number
  /** After a failed or refused sync, how long before trying again. */
  retryMs?: number
  /** Asks the storefront to refresh its prices; null when APP_URL is unset. */
  refreshPrices?: (() => Promise<boolean>) | null
  log: Log
  now?: () => Date
}

const HOUR = 3_600_000

function lastSuccess(last: LastRun | null): Date | null {
  const value = last?.detail.lastSuccessAt
  if (typeof value !== 'string') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

/** Due when no sync has succeeded within the interval, unless one just failed. */
export function isDue(last: LastRun | null, now: Date, everyMs: number, retryMs: number): boolean {
  if (!last) return true
  const success = lastSuccess(last)
  if (success && now.getTime() - success.getTime() < everyMs) return false
  const failed = last.detail.outcome === 'failed' || last.detail.outcome === 'refused'
  return !(failed && now.getTime() - last.at.getTime() < retryMs)
}

export function createCatalogueSchedule<R extends Outcome = SyncResult>(
  options: CatalogueScheduleOptions<R>,
) {
  const {
    sync,
    summarise: count = (result: R) => summarise(result as unknown as SyncResult),
    label = 'catalogue sync',
    runs,
    everyMs,
    checkEveryMs = 30 * 60_000,
    retryMs = HOUR,
    refreshPrices = null,
    log,
    now = () => new Date(),
  } = options

  async function record(detail: Record<string, unknown>) {
    try {
      await runs.record(detail)
    } catch (error) {
      log.error({ err: error }, `${label} outcome not recorded`)
    }
  }

  /** One look: syncs if one is due. */
  async function runOnce(): Promise<ScheduleResult<R>> {
    let last: LastRun | null
    try {
      last = await runs.last()
    } catch (error) {
      // Without the last run we cannot tell whether this week's is done.
      log.error({ err: error }, `${label} not started: last run unknown`)
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    const started = now()
    if (!isDue(last, started, everyMs, retryMs)) return { status: 'skipped' }
    const previousSuccess = lastSuccess(last)?.toISOString() ?? null

    let result: R
    try {
      result = await sync()
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      log.error({ reason }, `${label} failed; costs unchanged`)
      await record({ outcome: 'failed', reason, lastSuccessAt: previousSuccess })
      return { status: 'failed', reason }
    }

    const counts = count(result)
    if (result.outcome === 'refused') {
      log.error(
        { reason: result.reason, ...counts },
        `${label} refused the listing; costs unchanged`,
      )
      await record({
        outcome: 'refused',
        reason: result.reason,
        ...counts,
        lastSuccessAt: previousSuccess,
      })
      return { status: 'done', result, pricesRefreshed: null }
    }

    let pricesRefreshed: boolean | null = null
    if (result.outcome === 'written' && refreshPrices) {
      pricesRefreshed = await refreshPrices()
      if (!pricesRefreshed) log.warn({}, 'site did not refresh its prices; it will within the hour')
    }
    log.info({ outcome: result.outcome, ...counts, pricesRefreshed }, `${label} finished`)
    await record({
      outcome: result.outcome,
      ...counts,
      pricesRefreshed,
      lastSuccessAt: started.toISOString(),
    })
    return { status: 'done', result, pricesRefreshed }
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    await runOnce()
    if (!running) return
    timer = setTimeout(() => {
      current = cycle()
    }, checkEveryMs)
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
 * The gateway's schedule, or null where it must not run. It writes the one
 * catalogue every live price is built from, so only the production
 * deployment reading the production catalogue runs it: never a laptop, and
 * never from the sandbox's prices.
 */
export function catalogueScheduleFor(
  env: Env,
  log: Log,
  /** Test seams: the network boundaries. */
  deps: {
    client?: SupabaseClient<Database>
    getJson?: typeof getJson
    fetchImpl?: typeof fetch
  } = {},
) {
  if (env.NODE_ENV !== 'production' || env.DNA_ENV !== 'production') return null

  const client =
    deps.client ??
    createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  const source = createCatalogueSource({
    resellerId: env.DNA_RESELLER_ID,
    apiKey: env.DNA_API_KEY,
    environment: 'production',
    // Normal priority in the two supplier slots: a search's exact match goes first.
    run: (task) => supplierSlots.run(task, { waitMs: 5 * 60_000 }),
    ...(deps.getJson ? { getJson: deps.getJson } : {}),
  })
  const store = createCatalogueStore(client)
  return createCatalogueSchedule({
    sync: () => syncCatalogue({ source, store, apply: true }),
    runs: createRunLog(client),
    everyMs: env.CATALOGUE_SYNC_EVERY_HOURS * HOUR,
    refreshPrices: env.APP_URL ? createPriceRefresh(env.APP_URL, deps.fetchImpl) : null,
    log,
  })
}
