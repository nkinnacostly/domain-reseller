import type { PortfolioReader, RegistryListing } from '../provisioning/registrar'
import { compareWithRegistry, type Finding } from './compare'
import type { ReconcileStore } from './store'

/**
 * Reads the whole portfolio from the supplier and records how it differs
 * from ours (PRD §13.5 "Portfolio reconcile"). Read-only at the supplier.
 *
 * A run is all or nothing: if any page cannot be read, nothing is recorded,
 * because a partial listing would report every unread domain as missing.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type ReconcileResult =
  | { status: 'skipped' }
  | { status: 'failed'; reason: string }
  | { status: 'done'; seen: number; findings: Finding[] }

export type ReconcilerOptions = {
  store: ReconcileStore
  reader: PortfolioReader
  testMode: boolean
  everyMs: number
  log: Log
  pageSize?: number
  warnDays?: number
  now?: () => Date
}

/** How soon to try again after a failed run. */
const RETRY_MS = 5 * 60_000

/** Far beyond any real portfolio; stops a supplier bug from paging forever. */
const MAX_DOMAINS = 100_000

/** Kinds that mean money or a customer's domain is at stake. */
export const URGENT_FINDINGS: ReadonlySet<string> = new Set([
  'supplier_renewed',
  'registered_but_failed',
  'missing_at_registry',
])

export function createReconciler(options: ReconcilerOptions) {
  const {
    store,
    reader,
    testMode,
    everyMs,
    log,
    pageSize = 100,
    warnDays = 45,
    now = () => new Date(),
  } = options

  async function readPortfolio(): Promise<RegistryListing[] | { failed: string }> {
    const listing: RegistryListing[] = []
    for (let skip = 0; skip < MAX_DOMAINS; skip += pageSize) {
      const page = await reader.listPage(skip, pageSize)
      if (page.kind !== 'ok') return { failed: `${page.code}: ${page.message}` }
      listing.push(...page.data.items)
      if (page.data.items.length === 0 || skip + pageSize >= page.data.total) return listing
    }
    return { failed: 'Portfolio larger than expected; stopped paging' }
  }

  /** One pass. `force` ignores the interval since the last run. */
  async function runOnce({ force = false } = {}): Promise<ReconcileResult> {
    const runId = await store.begin(testMode, force ? 0 : Math.floor(everyMs / 1000))
    if (!runId) return { status: 'skipped' }

    try {
      const listing = await readPortfolio()
      if (!Array.isArray(listing)) {
        await store.fail(runId, listing.failed)
        log.warn({ runId, reason: listing.failed }, 'reconcile stopped: portfolio not read')
        return { status: 'failed', reason: listing.failed }
      }

      const ours = await store.loadOurs(testMode)
      const comparison = compareWithRegistry(ours, listing, { now: now(), warnDays })
      await store.record(runId, comparison, listing.length)

      const counts: Record<string, number> = {}
      for (const finding of comparison.findings) {
        counts[finding.kind] = (counts[finding.kind] ?? 0) + 1
      }
      const urgent = comparison.findings.some((finding) => URGENT_FINDINGS.has(finding.kind))
      log[urgent ? 'error' : comparison.findings.length ? 'warn' : 'info'](
        { runId, seen: listing.length, findings: counts },
        'reconcile finished',
      )
      return { status: 'done', seen: listing.length, findings: comparison.findings }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await store.fail(runId, reason).catch(() => undefined)
      log.error({ runId, err: error }, 'reconcile crashed')
      return { status: 'failed', reason }
    }
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  /** Runs, then books the next run: sooner after a failure, so a network blip costs minutes, not an hour. */
  async function cycle() {
    const result = await runOnce().catch((error): ReconcileResult => {
      log.error({ err: error }, 'reconcile could not start')
      return { status: 'failed', reason: String(error) }
    })
    if (!running) return
    const wait = result.status === 'failed' ? Math.min(RETRY_MS, everyMs) : everyMs
    timer = setTimeout(() => {
      current = cycle()
    }, wait)
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
