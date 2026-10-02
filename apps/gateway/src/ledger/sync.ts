import type { LedgerSource } from './source'
import type { LedgerStore } from './store'

/**
 * The supplier ledger mirror, read on a schedule on the side this gateway
 * writes to (docs/ADMIN-SPEC.md §4.4, §7). Each run reads everything since
 * the newest entry held, overlapping the last read by a day; a complete read
 * is recorded and the heartbeat says so, with the moment the read began
 * (`readAt`) — the gap alert compares balance snapshots up to it. A refused
 * or failed read records no rows, only a failed heartbeat that still names
 * the last good read.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

/** Before the first entry: the account's first top-up was on 23 Sept 2026. */
export const LEDGER_EPOCH = new Date('2026-09-01T00:00:00Z')

export type LedgerRun =
  | { outcome: 'ok'; read: number; inserted: number; statusChanged: number; revised: number }
  | { outcome: 'failed'; reason: string }

export function ledgerHeartbeat(testMode: boolean): string {
  return `supplier_ledger:${testMode ? 'ote' : 'production'}`
}

export function createLedgerSync(options: {
  source: LedgerSource
  store: LedgerStore
  testMode: boolean
  everyMs: number
  log: Log
  now?: () => Date
}) {
  const { source, store, testMode, everyMs, log, now = () => new Date() } = options
  const heartbeat = ledgerHeartbeat(testMode)

  async function beat(detail: Record<string, unknown>) {
    try {
      await store.beat(heartbeat, testMode, detail)
    } catch (error) {
      log.error({ err: error }, 'supplier ledger heartbeat not recorded')
    }
  }

  async function runOnce(): Promise<LedgerRun> {
    const startedAt = now().toISOString()
    let lastOk: string | null = null
    try {
      lastOk = await store.lastOkReadAt(heartbeat)
      const since = (await store.latestOccurredAt(testMode)) ?? LEDGER_EPOCH
      const read = await source(since)
      const recorded = await store.record(testMode, read.rows)
      const lastOccurredAt = read.rows.reduce<string | null>(
        (latest, row) => (latest === null || row.occurredAt > latest ? row.occurredAt : latest),
        null,
      )
      await beat({
        outcome: 'ok',
        read: read.read,
        ...recorded,
        lastOccurredAt,
        readAt: read.readAt,
      })
      if (recorded.inserted > 0 || recorded.statusChanged > 0 || recorded.revised > 0) {
        log.info({ testMode, read: read.read, ...recorded }, 'supplier ledger read')
      }
      return { outcome: 'ok', read: read.read, ...recorded }
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      log.warn({ testMode, reason }, 'supplier ledger not read; nothing recorded')
      await beat({ outcome: 'failed', reason, startedAt, lastOkReadAt: lastOk })
      return { outcome: 'failed', reason }
    }
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    await runOnce()
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
