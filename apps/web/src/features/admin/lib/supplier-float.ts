import { formatCount, formatUsd, formatWat, formatWatDate, formatWatTime } from './format'
import type { FloatState } from './overview-data'
import { aboutDays, runwayLine, targetKnown, targetLine } from './overview-float'
import type { Tone } from './tone'

/**
 * The Supplier page's balance tiles (docs/ADMIN-SPEC.md §5.2 B6, §6;
 * FR-FLOAT-2, FR-FLOAT-4): the latest snapshot, what is committed, the burn,
 * the runway on 7-day burn, the 21-day target and the alert level. Every
 * figure is `admin_float`'s, in cents; this only words it — with the
 * overview's own runway and target sentences, so both pages say the same.
 */

export type BalanceTile = {
  key: 'snapshot' | 'committed' | 'burn7' | 'burn30' | 'runway' | 'target' | 'alert' | 'unexplained'
  label: string
  value: string
  hint: string
  tone: Tone
  href?: string
}

const SIDE_WORD = { live: 'live', test: 'test' } as const

/** "14:15 WAT" today; the date too when it was another day. */
function atTime(value: string, now: Date): string {
  return formatWatDate(value) === formatWatDate(now) ? formatWatTime(value) : formatWat(value)
}

/** The runway as a tile's figure: "about 12 days", "Short by $4.20", "Unknown", "No spend". */
export function runwayValue(float: FloatState): string {
  if (float.balanceCents === null || float.balanceCents === undefined) return '—'
  if (float.shortByCents !== null && float.shortByCents !== undefined && float.shortByCents > 0) {
    return `Short by ${formatUsd(float.shortByCents)}`
  }
  if (float.burnState !== 'known') return 'Unknown'
  if (float.burn7dCents <= 0 || float.runwayDays === null || float.runwayDays === undefined) {
    return 'No spend'
  }
  return aboutDays(float.runwayDays)
}

/** "N older lines not costed": paid lines priced at today's prices, not their checkout cost. */
export function uncostedWords(lines: number): string | null {
  if (lines <= 0) return null
  return `${formatCount(lines)} older ${lines === 1 ? 'line' : 'lines'} not costed`
}

export function balanceTiles(
  float: FloatState,
  now: Date,
  unexplained: number | null,
): BalanceTile[] {
  const side = SIDE_WORD[float.side]
  const hasBalance = float.balanceCents !== null && float.balanceCents !== undefined
  const runway = runwayLine(float, now)
  const target = targetLine(float)
  const uncosted = uncostedWords(float.uncostedLines)
  const below =
    hasBalance &&
    float.alertCents !== null &&
    float.alertCents !== undefined &&
    (float.balanceCents as number) < float.alertCents

  const tiles: BalanceTile[] = [
    {
      key: 'snapshot',
      label: 'Latest snapshot',
      value: hasBalance ? formatUsd(float.balanceCents) : '—',
      hint:
        hasBalance && float.takenAt
          ? `Taken ${atTime(float.takenAt, now)}, ${side} side`
          : `No balance snapshot on the ${side} side yet`,
      tone: hasBalance ? (below ? 'warning' : 'neutral') : 'neutral',
    },
    {
      key: 'committed',
      label: 'Committed',
      value: formatUsd(float.committedCents),
      hint: uncosted
        ? `Paid-for work not yet bought: ${uncosted}, so counted at today's prices`
        : 'Paid-for work not yet bought from DomainNameAPI',
      tone: float.uncostedLines > 0 ? 'info' : 'neutral',
    },
    {
      key: 'burn7',
      label: 'Burn, 7 days',
      value: formatUsd(float.burn7dCents),
      hint: 'Settled supplier debits in the last 7 days',
      tone: 'neutral',
    },
    {
      key: 'burn30',
      label: 'Burn, 30 days',
      value: formatUsd(float.burn30dCents),
      hint: 'Settled supplier debits in the last 30 days',
      tone: 'neutral',
    },
    {
      key: 'runway',
      label: 'Runway on 7-day burn',
      value: runwayValue(float),
      hint: runway.text,
      tone: runway.tone,
    },
    {
      key: 'target',
      label: '21-day target',
      value: targetKnown(float) ? formatUsd(float.target21dCents) : '—',
      hint: target.text,
      tone: target.tone,
    },
    {
      key: 'alert',
      label: 'Alert level',
      value:
        float.alertCents === null || float.alertCents === undefined
          ? '—'
          : formatUsd(float.alertCents),
      hint: below
        ? 'The balance is below it: a float-low alert is open'
        : 'Below this balance, a float-low alert is raised',
      tone: below ? 'warning' : 'neutral',
    },
  ]
  if (unexplained !== null) {
    tiles.push({
      key: 'unexplained',
      label: 'Unexplained charges',
      value: formatCount(unexplained),
      hint:
        unexplained > 0
          ? 'Supplier debits with no matching order, charged twice, or on a refunded line'
          : 'Every supplier debit is matched or explained',
      tone: unexplained > 0 ? 'danger' : 'ok',
      href: '/admin/supplier/ledger?status=unexplained',
    })
  }
  return tiles
}

/** When the ledger behind the burn was last read from DomainNameAPI. */
export function ledgerReadLine(
  float: Pick<FloatState, 'ledgerReadAt' | 'burnState'>,
  now: Date,
): string {
  if (!float.ledgerReadAt) return 'The supplier ledger has not been read on this side yet.'
  const stale =
    float.burnState === 'stale' ? ' — over 3 hours ago, so burn and runway are stale' : ''
  return `Supplier ledger last read ${atTime(float.ledgerReadAt, now)}${stale}.`
}

/**
 * "$43.38 at 14:05 WAT on live (snapshot 14:00: $43.38)" — the live read
 * beside the latest snapshot, so a difference is visible at a glance (§5.2).
 */
export function liveBalanceLine(
  read: { balanceCents: number; readAt: string; side: 'live' | 'test' },
  snapshot: { balanceCents: number | null | undefined; takenAt: string | null | undefined },
  now: Date,
): string {
  const head = `${formatUsd(read.balanceCents)} at ${atTime(read.readAt, now)} on ${read.side}`
  if (snapshot.balanceCents === null || snapshot.balanceCents === undefined || !snapshot.takenAt) {
    return `${head} (no snapshot on this side yet)`
  }
  const taken = formatWatTime(snapshot.takenAt).replace(/ WAT$/, '')
  return `${head} (snapshot ${taken}: ${formatUsd(snapshot.balanceCents)})`
}

/** How the live read compares with the snapshot: a difference is worth a look. */
export function liveBalanceDifference(
  readCents: number,
  snapshotCents: number | null | undefined,
): string | null {
  if (snapshotCents === null || snapshotCents === undefined) return null
  const moved = readCents - snapshotCents
  if (moved === 0) return 'The same as the latest snapshot.'
  return moved < 0
    ? `${formatUsd(-moved)} lower than the latest snapshot: money spent since it was taken.`
    : `${formatUsd(moved)} higher than the latest snapshot: money added since it was taken.`
}
