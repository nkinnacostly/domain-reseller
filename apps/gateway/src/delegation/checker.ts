import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { type CheckedStatus, judgeDelegation } from './judge'
import { createNsLookup, type NsLookup } from './resolvers'
import {
  createDelegationStore,
  type DelegationResult,
  type DelegationStore,
  type DueDomain,
} from './store'

/**
 * Delegation verification (PRD FR-D5). A nameserver change leaves the domain
 * `pending`; this asks public resolvers whether the world now sees our
 * nameservers, and records `verified`, `failed` or `pending`. Read-only
 * everywhere but our own `domains` rows; it never calls the supplier.
 *
 * Small batches, a few lookups at a time: two DNS-over-HTTPS requests per
 * domain, every few hours per domain.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type DelegationCheckerOptions = {
  store: DelegationStore
  lookup: NsLookup
  everyMs: number
  log: Log
  /** How long a checked domain rests before it is due again (the function's default). */
  recheckHours?: number
  batchSize?: number
  /** Bounds one run, so a large portfolio is worked through over several. */
  maxBatches?: number
  /** Domains looked up at once. */
  concurrency?: number
  now?: () => Date
}

/**
 * `domains_for_delegation_check` also returns domains still on the
 * supplier's default nameservers (`undelegated`), which a check must not
 * mark "pointed and working", and which cannot be stamped as checked without
 * changing their status. They are skipped — and, never stamped, they stay at
 * the head of the queue, so each read asks for the function's maximum and
 * takes the batch from what is left.
 */
const READ_LIMIT = 500

export type CheckRun = { checked: number } & Record<CheckedStatus, number>

async function inTurns<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export function createDelegationChecker(options: DelegationCheckerOptions) {
  const {
    store,
    lookup,
    everyMs,
    log,
    recheckHours = 6,
    batchSize = 25,
    maxBatches = 8,
    concurrency = 4,
    now = () => new Date(),
  } = options

  /** One run: due domains in batches, until none are left or the run's bound. */
  async function runOnce(): Promise<CheckRun> {
    const run: CheckRun = { checked: 0, verified: 0, failed: 0, pending: 0 }

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const due = (await store.due(READ_LIMIT, recheckHours))
        .filter(
          (domain): domain is DueDomain & { status: CheckedStatus } =>
            domain.status !== 'undelegated' && domain.nameservers.length > 0,
        )
        .slice(0, batchSize)
      if (due.length === 0) break

      const changes = await store.lastChanges(due.map((domain) => domain.id))
      const results = await inTurns(due, concurrency, async (domain): Promise<DelegationResult> => {
        const views = await lookup(domain.domainName)
        const status = judgeDelegation({
          nameservers: domain.nameservers,
          current: domain.status,
          views,
          changedAt: changes.get(domain.id) ?? null,
          now: now(),
        })
        return { domainId: domain.id, status, observed: views }
      })
      await store.record(results)

      run.checked += results.length
      for (const result of results) run[result.status] += 1
      if (due.length < batchSize) break
    }

    if (run.checked > 0) log.info(run, 'delegation check finished')
    return run
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    try {
      await runOnce()
    } catch (error) {
      log.error({ err: error }, 'delegation check failed')
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
 * The gateway's checker, or null where it must not run. It writes to live
 * customers' domains, which belong to the gateway that registers on the live
 * registry — env.ts allows that only in a production deployment — so a
 * laptop or the sandbox gateway never touches them. The sandbox has nothing
 * to check: its names are not in public DNS.
 */
export function delegationCheckerFor(
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
  return createDelegationChecker({
    store: createDelegationStore(client),
    lookup: createNsLookup(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    everyMs: env.DELEGATION_CHECK_MINUTES * 60_000,
    log,
  })
}
