import { capLevel } from '@dr/shared/mail'

/**
 * A cap and what has been counted against it (MAIL-SPEC §8: recipients, as
 * SES counts them), for a meter. The level words the 80% warning and the
 * cap itself (§8: "at 80% of a cap, … a banner; at 100%, quota_exceeded").
 */
export type Meter = {
  used: number
  cap: number
  /** 0–100, whole; a cap of nothing reads as full. */
  percent: number
  level: 'ok' | 'warning' | 'reached'
}

export function meter(used: number, cap: number): Meter {
  const safeUsed = Math.max(0, Math.floor(used))
  const safeCap = Math.max(0, Math.floor(cap))
  const percent = safeCap === 0 ? 100 : Math.min(100, Math.round((safeUsed / safeCap) * 100))
  return { used: safeUsed, cap: safeCap, percent, level: capLevel(safeUsed, safeCap) }
}

const count = new Intl.NumberFormat('en-NG')

export const formatCount = (n: number) => count.format(n)

export const METER_WORDS: Record<Meter['level'], string | null> = {
  ok: null,
  warning: 'Over 80% used',
  reached: 'Cap reached: new emails are refused until it resets',
}

/** The day's and month's sends as `mail.account_usage` answers them (migration 46). */
export type UsageCounts = {
  queued: number
  sent: number
  delivered: number
  bounced: number
  complained: number
  failed: number
}

export type AccountUsage = {
  day: string
  monthStart: string
  planCode: string
  caps: { daily: number; monthly: number }
  today: UsageCounts
  month: UsageCounts
}

const COUNT_KEYS = ['queued', 'sent', 'delivered', 'bounced', 'complained', 'failed'] as const

function counts(value: unknown): UsageCounts | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const out = {} as UsageCounts
  for (const key of COUNT_KEYS) {
    const n = Number(record[key])
    if (!Number.isFinite(n) || n < 0) return null
    out[key] = n
  }
  return out
}

/** Reads the function's answer; null for anything else (an error state, never a guess). */
export function readUsage(value: unknown): AccountUsage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.ok !== true) return null
  const caps = record.caps as Record<string, unknown> | undefined
  const daily = Number(caps?.daily)
  const monthly = Number(caps?.monthly)
  const today = counts(record.today)
  const month = counts(record.month)
  if (!Number.isFinite(daily) || !Number.isFinite(monthly) || !today || !month) return null
  if (typeof record.day !== 'string' || typeof record.monthStart !== 'string') return null
  return {
    day: record.day,
    monthStart: record.monthStart,
    planCode: String(record.planCode ?? ''),
    caps: { daily, monthly },
    today,
    month,
  }
}
