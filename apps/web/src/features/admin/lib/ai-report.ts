import { formatUsdCents } from '@dr/shared/admin'
import { z } from 'zod'

/**
 * The AI page's numbers (AI phase 4, migration 75 `admin_ai_report`), parsed
 * strictly: an answer of any other shape is no answer. Spend is null for a
 * test administrator — one DeepSeek account serves both sides.
 */

const count = z.number().int().nonnegative()

const featureRow = z.object({
  feature: z.string(),
  calls: count,
  failed: count,
  declined: count,
  promptTokens: count,
  cachedTokens: count,
  completionTokens: count,
  costMicro: count,
})

const reportSchema = z.object({
  spend: z
    .object({
      monthMicro: count,
      budgetCents: count,
      since: z.string().nullable(),
      features: z.array(featureRow),
      daily: z.array(z.object({ day: z.string(), costMicro: count })),
    })
    .nullable(),
  lines: z.object({ paid: count, nameFinder: count, assistantLink: count }),
  delegation: z.object({ registered: count, verifiedIn7: count }),
  screening: z.object({ screened: count, flagged: count, waiting: count }),
  bulk: z.object({ agencies: count, current: count, prior: count }),
})

export type AiReport = z.infer<typeof reportSchema>
export type AiFeatureRow = z.infer<typeof featureRow>

export function parseAiReport(json: unknown): AiReport | null {
  const parsed = reportSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * Micro-dollars as people read them, rounded up to the cent so an estimate is
 * never shown below what it may be: "$1.24", "under $0.01", "$0.00".
 */
export function usdFromMicro(micro: number): string {
  if (micro <= 0) return '$0.00'
  if (micro < 10_000) return 'under $0.01'
  return formatUsdCents(Math.ceil(micro / 10_000))
}

/** "45%" — a whole percent, or null when there is nothing to divide by. */
export function percent(part: number, whole: number): string | null {
  if (whole <= 0) return null
  return `${Math.round((part / whole) * 100)}%`
}

/** One feature's calls split three ways: answered, could not help, no answer. */
export function outcomes(row: AiFeatureRow | undefined): {
  calls: number
  answered: number
  declined: number
  failed: number
} {
  if (!row) return { calls: 0, answered: 0, declined: 0, failed: 0 }
  return {
    calls: row.calls,
    answered: Math.max(0, row.calls - row.failed - row.declined),
    declined: row.declined,
    failed: row.failed,
  }
}

/** Every WAT day from `from` to `to`, with the day's cost or 0 — a quiet day is a bar of nothing, not a gap. */
export function dailySeries(
  daily: readonly { day: string; costMicro: number }[],
  from: string,
  to: string,
): { day: string; costMicro: number }[] {
  const byDay = new Map(daily.map((entry) => [entry.day, entry.costMicro]))
  const days: { day: string; costMicro: number }[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10)
    days.push({ day, costMicro: byDay.get(day) ?? 0 })
  }
  return days
}
