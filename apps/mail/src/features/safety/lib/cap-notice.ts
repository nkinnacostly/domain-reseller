/**
 * The cap notices reserve_send records (MAIL-SPEC §8, migration 51): 80% and
 * 100% of the day's or the month's cap, once each. The dashboard shows the
 * one that matters most for the current day and month — a month at its cap
 * outlasts a day at its cap, and either outranks 80%.
 */

export type CapNotice = {
  scope: 'day' | 'month'
  level: 80 | 100
  cap: number
  used: number
}

type Row = {
  scope?: unknown
  period_start?: unknown
  level?: unknown
  cap?: unknown
  used?: unknown
}

const RANK = (notice: CapNotice) =>
  (notice.level === 100 ? 2 : 0) + (notice.scope === 'month' ? 1 : 0)

/** The notice for this Lagos day and month (`account_usage`'s day and monthStart), or null. */
export function pickCapNotice(
  rows: unknown,
  period: { day: string; monthStart: string },
): CapNotice | null {
  if (!Array.isArray(rows)) return null
  let best: CapNotice | null = null
  for (const raw of rows as Row[]) {
    const scope = raw?.scope
    const level = Number(raw?.level)
    const cap = Number(raw?.cap)
    const used = Number(raw?.used)
    if (scope !== 'day' && scope !== 'month') continue
    if (level !== 80 && level !== 100) continue
    if (!Number.isFinite(cap) || !Number.isFinite(used)) continue
    if (raw.period_start !== (scope === 'day' ? period.day : period.monthStart)) continue
    const notice: CapNotice = { scope, level, cap, used }
    if (!best || RANK(notice) > RANK(best)) best = notice
  }
  return best
}
