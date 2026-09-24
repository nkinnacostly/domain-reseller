import { formatAlerts } from './format'
import type { AlertStore } from './store'
import type { Notifier } from './telegram'

/**
 * Tells a person when money or a customer's domain needs them (PRD I5, I6,
 * §13.5; backlog L16). Every few minutes it:
 *   • records a heartbeat — a scheduled check elsewhere alerts if these stop,
 *     because a stopped gateway cannot report itself;
 *   • now and then records the supplier balance, for the float alert;
 *   • asks the database what is wrong and what is due to be said, and says it.
 * An alert is marked sent only once delivered, so a failed send is retried.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type MonitorOptions = {
  store: AlertStore
  /** Null when no channel is configured: alerts are then logged, by id and kind only. */
  notifier: Notifier | null
  testMode: boolean
  everyMs: number
  log: Log
  heartbeatName: string
  appName?: string
  /** Reads the supplier balance in USD, or null when it cannot. */
  readBalanceUsd?: () => Promise<number | null>
  balanceEveryMs?: number
  now?: () => Date
}

export function createAlertMonitor(options: MonitorOptions) {
  const {
    store,
    notifier,
    testMode,
    everyMs,
    log,
    heartbeatName,
    appName = 'MyDomainsHub',
    readBalanceUsd,
    balanceEveryMs = 30 * 60_000,
    now = () => new Date(),
  } = options
  let lastBalanceAt = 0

  async function heartbeat() {
    try {
      await store.heartbeat(heartbeatName, testMode, { checkedAt: now().toISOString() })
    } catch (error) {
      log.error({ err: error }, 'heartbeat not recorded')
    }
  }

  async function balance() {
    if (!readBalanceUsd || now().getTime() - lastBalanceAt < balanceEveryMs) return
    lastBalanceAt = now().getTime()
    try {
      const usd = await readBalanceUsd()
      if (usd !== null) await store.recordBalance(testMode, usd)
    } catch (error) {
      log.warn({ err: error }, 'supplier balance not recorded')
    }
  }

  /** One pass. Returns how many alerts were delivered. */
  async function runOnce(): Promise<number> {
    await heartbeat()
    await balance()

    const due = await store.sync(testMode)
    if (due.length === 0) return 0

    if (!notifier) {
      for (const alert of due) {
        const level = alert.type !== 'resolved' && alert.severity === 'critical' ? 'error' : 'warn'
        log[level](
          { alertId: alert.id, kind: alert.kind, type: alert.type },
          'ops alert (no channel configured)',
        )
      }
      await store.markNotified(
        due.filter((alert) => alert.type !== 'resolved').map((alert) => alert.id),
        due.filter((alert) => alert.type === 'resolved').map((alert) => alert.id),
      )
      return 0
    }

    const sentIds: number[] = []
    const resolvedIds: number[] = []
    for (const message of formatAlerts(due, testMode ? 'test' : 'live', appName)) {
      if (await notifier.send(message.text)) {
        sentIds.push(...message.alertIds)
        resolvedIds.push(...message.resolvedIds)
      }
    }
    if (sentIds.length || resolvedIds.length) await store.markNotified(sentIds, resolvedIds)
    if (sentIds.length + resolvedIds.length < due.length) {
      log.warn(
        { due: due.length, delivered: sentIds.length + resolvedIds.length },
        'some alerts not delivered; will retry',
      )
    }
    return sentIds.length + resolvedIds.length
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    try {
      await runOnce()
    } catch (error) {
      log.error({ err: error }, 'alert check failed')
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
