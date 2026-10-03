import { formatUsd, formatWat, formatWatDate, formatWatTime } from '@/features/admin/lib/format'
import type { Tone } from '@/features/admin/lib/tone'
import type { FloatState } from './overview-data'

/**
 * The overview's float tiles (docs/ADMIN-SPEC.md §5.2 B1, §6): the supplier
 * balance with its runway, and the 21-day target (FR-FLOAT-4). Every figure
 * is `admin_float`'s, in cents; this only words it. Runway on the last 7
 * days' spend is the PRD's rule (FR-FLOAT-2) — when the ledger is stale it
 * says "unknown" rather than guess from line costs.
 */

/** FR-FLOAT-2: below 10 days of cover is a warning; below 3 is a page. */
export const RUNWAY_WARNING_DAYS = 10
export const RUNWAY_CRITICAL_DAYS = 3

export type FloatLine = { tone: Tone; text: string }

/** "about 12 days", "about 1 day", "under a day". */
export function aboutDays(days: number): string {
  if (days < 1) return 'under a day'
  const whole = Math.round(days)
  return `about ${whole} ${whole === 1 ? 'day' : 'days'}`
}

/** "12 days", "under a day" — for the 30-day pace in brackets. */
function plainDays(days: number): string {
  if (days < 1) return 'under a day'
  const whole = Math.round(days)
  return `${whole} ${whole === 1 ? 'day' : 'days'}`
}

/**
 * The runway at the last 30 days' pace: (balance − committed) ÷ (burn₃₀ / 30),
 * from the same integer cents. Null when there is no balance or no spend.
 */
export function paceDays(
  float: Pick<FloatState, 'balanceCents' | 'committedCents' | 'burn30dCents'>,
): number | null {
  if (float.balanceCents === null || float.balanceCents === undefined) return null
  if (float.burn30dCents <= 0) return null
  return Math.max(((float.balanceCents - float.committedCents) * 30) / float.burn30dCents, 0)
}

export function runwayTone(days: number): Tone {
  if (days < RUNWAY_CRITICAL_DAYS) return 'danger'
  if (days < RUNWAY_WARNING_DAYS) return 'warning'
  return 'ok'
}

/** "14:15 WAT" today; the date too when it was another day. */
function atTime(value: string, now: Date): string {
  return formatWatDate(value) === formatWatDate(now) ? formatWatTime(value) : formatWat(value)
}

/**
 * The runway, in the words §5.2 gives: known, stale, no spend or short-by.
 * Short-by comes first — paid-for work the balance cannot cover is the most
 * urgent thing the tile can say.
 */
export function runwayLine(float: FloatState, now: Date): FloatLine {
  if (float.balanceCents === null || float.balanceCents === undefined) {
    return { tone: 'neutral', text: 'No balance snapshot on this side yet' }
  }
  if (float.shortByCents !== null && float.shortByCents !== undefined && float.shortByCents > 0) {
    return {
      tone: 'danger',
      text: `Short by ${formatUsd(float.shortByCents)} for work already paid for`,
    }
  }
  if (float.burnState === 'stale') {
    if (!float.ledgerReadAt) {
      return {
        tone: 'warning',
        text: 'Runway unknown — the supplier ledger has not been read on this side',
      }
    }
    const then = float.lastKnownRunway ? ` (then ${aboutDays(float.lastKnownRunway.days)})` : ''
    return {
      tone: 'warning',
      text: `Runway unknown — the supplier ledger was last read at ${atTime(float.ledgerReadAt, now)}${then}`,
    }
  }
  if (float.burnState === 'short_history') {
    return {
      tone: 'neutral',
      text: 'Runway unknown — the supplier ledger holds under 7 days of history',
    }
  }
  if (float.burn7dCents <= 0 || float.runwayDays === null || float.runwayDays === undefined) {
    return { tone: 'ok', text: 'No spend in the last 7 days' }
  }
  const pace = paceDays(float)
  const thirty = pace === null ? '' : ` (30-day pace: ${plainDays(pace)})`
  const about = aboutDays(float.runwayDays)
  return {
    tone: runwayTone(float.runwayDays),
    text: `${about.charAt(0).toUpperCase()}${about.slice(1)} at the last 7 days' spend${thirty}`,
  }
}

/** False while the ledger has never been read on the side: there is no spend to keep 21 days of. */
export function targetKnown(float: Pick<FloatState, 'burnState' | 'ledgerReadAt'>): boolean {
  return !(float.burnState === 'stale' && !float.ledgerReadAt)
}

/**
 * "Keep $Y (21 days of spend); top up $Z." (FR-FLOAT-4). The target is 21
 * days of the 7-day pace plus work already paid for, so the words say both.
 */
export function targetLine(float: FloatState): FloatLine {
  if (!targetKnown(float)) {
    return {
      tone: 'neutral',
      text: 'Not known until the supplier ledger has been read on this side.',
    }
  }
  const spend =
    float.burnState === 'stale'
      ? '21 days of spend, as of the last ledger read'
      : float.burnState === 'short_history'
        ? '21 days of spend, from under 7 days of ledger history'
        : '21 days of spend'
  const committed =
    float.committedCents > 0 ? ` plus ${formatUsd(float.committedCents)} already paid for` : ''
  const keep = `Keep ${formatUsd(float.target21dCents)} (${spend}${committed})`
  const topUp = float.topUpToTargetCents
  if (
    float.balanceCents === null ||
    float.balanceCents === undefined ||
    topUp === null ||
    topUp === undefined
  ) {
    return { tone: 'neutral', text: `${keep}. With no balance snapshot, the top-up is not known.` }
  }
  if (topUp > 0) return { tone: 'warning', text: `${keep}; top up ${formatUsd(topUp)}.` }
  return { tone: 'ok', text: `${keep}; no top-up needed.` }
}

/** "Snapshot 14:00 WAT" — when the balance shown was taken. */
export function snapshotLine(float: Pick<FloatState, 'takenAt'>, now: Date): string | null {
  return float.takenAt ? `Snapshot ${atTime(float.takenAt, now)}` : null
}
