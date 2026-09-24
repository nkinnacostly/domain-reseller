import type DomainNameApi from 'nodejs-dna'
import type { WriteTarget } from '../dna/client'
import type { Priority, Semaphore } from '../lib/semaphore'
import {
  type AuditSink,
  createDnaRegistrar,
  type Lookup,
  type Registrar,
  type RegistryDomain,
  type RegistryListing,
} from '../provisioning/registrar'
import { compareWithRegistry, type OurDomain } from './compare'
import type { DeepReading, DeepSyncStore } from './deep-sync-store'
import { URGENT_FINDINGS } from './reconciler'

/**
 * Domain deep sync (PRD §13.5): "GetDetails for domains changed in the last
 * 24h or flagged stale". The hourly reconcile reads the whole portfolio from
 * GetList; this reads one domain's own record, so each live domain is
 * checked on its own at least daily and soon after anything changes it.
 * nodejs-dna's SyncFromRegistry is GetDetails under another name, so this
 * read is the whole of it.
 *
 * The decision is the reconcile's: our one domain against a one-line listing
 * made from the answer, through compareWithRegistry, so a reading corrects
 * and flags exactly what a portfolio run would. Read-only at the supplier.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

type Answered = Extract<Lookup, { kind: 'found' | 'not_found' }>

/**
 * The lookup's record as a listing line. The lookup keeps no renewal mode
 * (RegistryDomain has none), so here it is unknown, never "off": the store
 * keeps the one the reconcile last saw, and no supplier_may_renew is raised
 * on a guess — the hourly reconcile raises it from GetList.
 */
export function asListing(domainName: string, domain: RegistryDomain): RegistryListing {
  return {
    domainName: domainName.toLowerCase(),
    status: domain.status ?? '',
    expiresAt: domain.expiresAt,
    nameservers: domain.nameservers,
    transferLock: domain.transferLock,
    privacy: domain.privacy,
    renewalMode: null,
  }
}

/**
 * What one reading means for one domain. `not_found` is an empty listing:
 * a domain we hold that the registry does not list, as the portfolio run
 * would find it — and a transfer in still under way is left to its job there
 * too, never counted twice.
 */
export function readingFor(
  ours: OurDomain,
  lookup: Answered,
  { now, warnDays = 45 }: { now: Date; warnDays?: number },
): DeepReading {
  const listing = lookup.kind === 'found' ? [asListing(ours.domainName, lookup.domain)] : []
  const { updates, findings } = compareWithRegistry([ours], listing, { now, warnDays })
  // An answer without a status says nothing about the status: no mismatch.
  const statusKnown = lookup.kind === 'found' && Boolean(lookup.domain.status)
  const kept = statusKnown
    ? findings
    : findings.filter((finding) => finding.kind !== 'status_mismatch')

  const update = updates[0] ?? null
  const changes =
    update !== null &&
    (update.expiresAt !== undefined ||
      update.nameservers !== undefined ||
      update.transferLock !== undefined ||
      update.privacy !== undefined ||
      update.events.length > 0)
  // Nothing to correct and nothing to flag: the registry agreed, stamp only.
  return { update: changes || kept.length > 0 ? update : null, findings: kept }
}

/**
 * Each read waits in the supplier's low lane, behind every search a person is
 * waiting on; bulk search shares the lane, which holds one of the two slots
 * at most. A read that waits longer than this is skipped until the next run.
 */
export const DEEP_SYNC_SLOT: { waitMs: number; priority: Priority } = {
  waitMs: 2 * 60_000,
  priority: 'low',
}

/** The deep sync's reader: the registrar every job uses, in the low lane. */
export function createDeepSyncReader(deps: {
  client: DomainNameApi
  environment: WriteTarget
  audit: AuditSink
  slots?: Semaphore
}): Pick<Registrar, 'lookup'> {
  return createDnaRegistrar({ ...deps, slotWait: DEEP_SYNC_SLOT })
}

export type DeepSyncRun = {
  due: number
  /** Read and recorded. */
  read: number
  /** Recorded as agreeing: stamped only. */
  agreed: number
  /** Recorded with the registry's values copied over. */
  corrected: number
  /** Not read: no answer, or the supplier refused us. Nothing recorded. */
  skipped: number
  findings: Record<string, number>
}

export type DeepSyncOptions = {
  store: DeepSyncStore
  reader: Pick<Registrar, 'lookup'>
  testMode: boolean
  everyMs: number
  log: Log
  batchSize?: number
  warnDays?: number
  now?: () => Date
}

export function createDeepSync(options: DeepSyncOptions) {
  const {
    store,
    reader,
    testMode,
    everyMs,
    log,
    batchSize = 25,
    warnDays = 45,
    now = () => new Date(),
  } = options

  async function runOnce(): Promise<DeepSyncRun> {
    const due = await store.due(testMode, batchSize)
    const run: DeepSyncRun = {
      due: due.length,
      read: 0,
      agreed: 0,
      corrected: 0,
      skipped: 0,
      findings: {},
    }

    // One domain at a time: each read holds a supplier slot, and each reading
    // is compared with our row as it was just before the read.
    for (const domain of due) {
      const lookup = await reader.lookup(domain.domainName)

      // N3's rule for reads: an answer we do not have decides nothing.
      if (lookup.kind === 'blocked') {
        run.skipped += 1
        // Credentials or our address: every other read would be refused too.
        log.error(
          { domainId: domain.id, code: lookup.code },
          'deep sync stopped: the supplier refused the read',
        )
        break
      }
      if (lookup.kind === 'unknown') {
        run.skipped += 1
        log.warn(
          { domainId: domain.id, code: lookup.code },
          'deep sync: no answer from the registry, nothing recorded',
        )
        continue
      }

      const reading = readingFor(domain, lookup, { now: now(), warnDays })
      await store.record(domain.id, testMode, reading)
      run.read += 1
      if (reading.update) run.corrected += 1
      else if (reading.findings.length === 0) run.agreed += 1
      for (const finding of reading.findings) {
        run.findings[finding.kind] = (run.findings[finding.kind] ?? 0) + 1
      }
    }

    if (run.due > 0) {
      const kinds = Object.keys(run.findings)
      const urgent = kinds.some((kind) => URGENT_FINDINGS.has(kind))
      log[urgent ? 'error' : kinds.length > 0 ? 'warn' : 'info'](run, 'deep sync finished')
    }
    return run
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    try {
      await runOnce()
    } catch (error) {
      log.error({ err: error }, 'deep sync failed')
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
