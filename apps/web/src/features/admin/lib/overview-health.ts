import { ago, formatWat } from '@/features/admin/lib/format'
import type { AdminSide } from '@/features/admin/lib/side'
import type { Tone } from '@/features/admin/lib/tone'
import type { CronJob, FloatState, Health, Heartbeat } from './overview-data'

/**
 * The overview's health strip (docs/ADMIN-SPEC.md §5.2 B1): each service as
 * a dot and a word, from `admin_overview.health`. A tile says what it saw and
 * when — never more than the data shows (N9b). The thresholds are the
 * spec's; the schedules behind them are in the comments.
 */

export const HEALTH_LIMITS = {
  /** The gateway's monitor beats every few minutes. */
  gatewayMinutes: 15,
  /** The reconcile runs hourly (PRD §13.5). */
  reconcileHours: 2,
  /** Both catalogue syncs run weekly. */
  catalogueDays: 8,
  /** The ledger is mirrored hourly; stale at 3 h (§7, `supplier_ledger_stale`). */
  ledgerHours: 3,
  /** Snapshots every 15 minutes (FR-FLOAT-1). */
  snapshotMinutes: 30,
  /** The FX job runs daily at 08:00 WAT and activates a fresh rate each day. */
  fxHours: 48,
  /** ERRP expiry notices go out daily; stale at 26 h (`cron_stale:email-notices`). */
  noticesHours: 26,
} as const

export type HealthItem = {
  key: string
  label: string
  tone: Tone
  /** One word, beside the dot: colour is never the only signal (S8). */
  word: string
  detail: string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function age(at: string | null | undefined, now: Date): number | null {
  if (!at) return null
  const time = new Date(at).getTime()
  return Number.isNaN(time) ? null : now.getTime() - time
}

const env = (side: AdminSide) => (side === 'test' ? 'ote' : 'production')

function beat(heartbeats: readonly Heartbeat[], name: string): Heartbeat | undefined {
  return heartbeats.find((h) => h.name === name)
}

const ok = (key: string, label: string, detail: string): HealthItem => ({
  key,
  label,
  tone: 'ok',
  word: 'OK',
  detail,
})
const none = (key: string, label: string, detail: string): HealthItem => ({
  key,
  label,
  tone: 'neutral',
  word: 'No record',
  detail,
})

/** Gateway: OK while its heartbeat is under 15 minutes old. */
export function gatewayHealth(
  heartbeats: readonly Heartbeat[],
  side: AdminSide,
  now: Date,
): HealthItem {
  const label = 'Gateway'
  const hb = beat(heartbeats, `gateway:${env(side)}`)
  const elapsed = age(hb?.beatAt, now)
  if (elapsed === null) {
    return none(
      'gateway',
      label,
      side === 'test'
        ? 'No sandbox gateway has reported on the test side'
        : 'The gateway has not reported',
    )
  }
  if (elapsed < HEALTH_LIMITS.gatewayMinutes * MINUTE) {
    return ok('gateway', label, `Last seen ${ago(hb?.beatAt, now)}`)
  }
  return {
    key: 'gateway',
    label,
    tone: 'danger',
    word: 'Late',
    detail: `Last seen ${ago(hb?.beatAt, now)}`,
  }
}

/** Registry reconcile: OK when the last run finished under 2 hours ago, without an error. */
export function reconcileHealth(reconcile: Health['reconcile'], now: Date): HealthItem {
  const label = 'Registry reconcile'
  const elapsed = age(reconcile?.finishedAt, now)
  if (!reconcile || elapsed === null) {
    return none('reconcile', label, 'No finished run on this side')
  }
  const when = ago(reconcile.finishedAt, now)
  // The error text can carry a registry's own words (N10): the Alerts page has the detail.
  if (reconcile.error) {
    return {
      key: 'reconcile',
      label,
      tone: 'danger',
      word: 'Failing',
      detail: `The last run, ${when}, ended with an error`,
    }
  }
  if (elapsed < HEALTH_LIMITS.reconcileHours * HOUR) {
    return ok('reconcile', label, `Last finished ${when}`)
  }
  return { key: 'reconcile', label, tone: 'warning', word: 'Late', detail: `Last finished ${when}` }
}

/**
 * A catalogue sync: OK under 8 days old and not refused (or failed). Both
 * syncs price the live catalogue, so they report on the live side only.
 */
export function catalogueHealth(
  heartbeats: readonly Heartbeat[],
  kind: 'catalogue' | 'ssl_catalogue',
  side: AdminSide,
  now: Date,
): HealthItem {
  const key = kind
  const label = kind === 'catalogue' ? 'Catalogue sync' : 'SSL catalogue sync'
  const hb = beat(heartbeats, `${kind}:production`)
  const elapsed = age(hb?.beatAt, now)
  if (elapsed === null) {
    if (side === 'test') {
      return {
        key,
        label,
        tone: 'neutral',
        word: 'Live only',
        detail: 'It prices the live catalogue, so it reports on the live side',
      }
    }
    return none(key, label, 'No run recorded')
  }
  const when = ago(hb?.beatAt, now)
  if (hb?.outcome === 'refused') {
    return {
      key,
      label,
      tone: 'danger',
      word: 'Refused',
      detail: `The last run, ${when}, refused a listing it could not trust`,
    }
  }
  if (hb?.outcome === 'failed') {
    return { key, label, tone: 'danger', word: 'Failing', detail: `The last run, ${when}, failed` }
  }
  if (elapsed < HEALTH_LIMITS.catalogueDays * DAY) return ok(key, label, `Last run ${when}`)
  return { key, label, tone: 'warning', word: 'Late', detail: `Last run ${when}` }
}

/** Supplier ledger: OK when the last successful read is under 3 hours old. */
export function ledgerHealth(
  heartbeats: readonly Heartbeat[],
  float: Pick<FloatState, 'ledgerReadAt'> | null,
  side: AdminSide,
  now: Date,
): HealthItem {
  const label = 'Supplier ledger'
  const hb = beat(heartbeats, `supplier_ledger:${env(side)}`)
  const lastGood = float?.ledgerReadAt ?? (hb?.outcome === 'ok' ? hb.beatAt : null)
  const elapsed = age(lastGood, now)
  const failed = hb?.outcome === 'failed'
  if (!hb && elapsed === null) {
    return none('ledger', label, 'The supplier ledger has not been read on this side')
  }
  if (elapsed !== null && elapsed < HEALTH_LIMITS.ledgerHours * HOUR) {
    const detail = `Last read ${ago(lastGood, now)}`
    return ok('ledger', label, failed ? `${detail}; the latest attempt failed` : detail)
  }
  const detail = elapsed === null ? 'No successful read yet' : `Last read ${ago(lastGood, now)}`
  if (failed) return { key: 'ledger', label, tone: 'danger', word: 'Failing', detail }
  return { key: 'ledger', label, tone: 'warning', word: 'Late', detail }
}

/** Balance snapshot: OK under 30 minutes old (one is taken every 15). */
export function snapshotHealth(snapshotAt: string | null | undefined, now: Date): HealthItem {
  const label = 'Balance snapshot'
  const elapsed = age(snapshotAt, now)
  if (elapsed === null) return none('snapshot', label, 'No snapshot on this side')
  const detail = `Last taken ${ago(snapshotAt, now)}`
  if (elapsed < HEALTH_LIMITS.snapshotMinutes * MINUTE) return ok('snapshot', label, detail)
  return { key: 'snapshot', label, tone: 'warning', word: 'Late', detail }
}

const RATE = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** FX: the active rate's age, and how many rates are held for review. */
export function fxHealth(fx: Health['fx'], now: Date): HealthItem {
  const label = 'FX rate'
  const elapsed = age(fx?.activeFrom, now)
  const pending = fx?.pendingCount ?? 0
  const held = pending > 0 ? `; ${pending} held for review` : ''
  if (!fx || elapsed === null || !fx.costingRate) {
    return {
      key: 'fx',
      label,
      tone: 'danger',
      word: 'No rate',
      detail: `No active exchange rate${held}`,
    }
  }
  const detail = `₦${RATE.format(fx.costingRate)} to the dollar, set ${ago(fx.activeFrom, now)}${held}`
  if (pending > 0) return { key: 'fx', label, tone: 'warning', word: 'Review', detail }
  if (elapsed >= HEALTH_LIMITS.fxHours * HOUR) {
    return { key: 'fx', label, tone: 'warning', word: 'Late', detail }
  }
  return ok('fx', label, detail)
}

const NOTICES_JOB = 'email-notices'

/**
 * Scheduled jobs: OK when no job's latest run failed and the ERRP notices job
 * succeeded within 26 hours. A failing job is named. A test administrator is
 * not shown the cron jobs (§3.2h).
 */
export function cronHealth(
  cron: readonly CronJob[] | undefined,
  testOnly: boolean,
  now: Date,
): HealthItem {
  const label = 'Scheduled jobs'
  if (!cron) {
    return testOnly
      ? {
          key: 'cron',
          label,
          tone: 'neutral',
          word: 'Hidden',
          detail: 'Not shown to test administrators',
        }
      : none('cron', label, 'The scheduled jobs could not be read')
  }
  if (cron.length === 0) return none('cron', label, 'No scheduled jobs found')
  const failing = cron.filter((job) => job.lastStatus === 'failed').map((job) => job.job)
  const notices = cron.find((job) => job.job === NOTICES_JOB)
  const noticesAge = age(notices?.lastSuccessAt, now)
  const failingWords = failing.length > 0 ? `Last run failed: ${failing.join(', ')}` : ''
  if (noticesAge === null || noticesAge >= HEALTH_LIMITS.noticesHours * HOUR) {
    const since = notices?.lastSuccessAt
      ? `last succeeded ${formatWat(notices.lastSuccessAt)}`
      : 'no successful run recorded'
    return {
      key: 'cron',
      label,
      tone: 'danger',
      word: 'Failing',
      detail: [`Expiry notices (${NOTICES_JOB}): ${since}`, failingWords]
        .filter(Boolean)
        .join('. '),
    }
  }
  if (failing.length > 0) {
    return { key: 'cron', label, tone: 'warning', word: 'Failing', detail: failingWords }
  }
  return ok('cron', label, `${cron.length} ${cron.length === 1 ? 'job' : 'jobs'}, none failing`)
}

/** Every tile, in the strip's order. */
export function healthItems({
  health,
  float,
  side,
  testOnly,
  now,
}: {
  health: Health
  float: Pick<FloatState, 'ledgerReadAt'> | null
  side: AdminSide
  testOnly: boolean
  now: Date
}): HealthItem[] {
  return [
    gatewayHealth(health.heartbeats, side, now),
    reconcileHealth(health.reconcile, now),
    catalogueHealth(health.heartbeats, 'catalogue', side, now),
    catalogueHealth(health.heartbeats, 'ssl_catalogue', side, now),
    ledgerHealth(health.heartbeats, float, side, now),
    snapshotHealth(health.snapshotAt, now),
    fxHealth(health.fx, now),
    cronHealth(health.cron, testOnly, now),
  ]
}
