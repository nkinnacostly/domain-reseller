import { z } from 'zod'

/**
 * What `admin_overview` answers (docs/ADMIN-SPEC.md §3.2h, §5.2 B1): one SQL
 * read for the whole page — aggregates belong in SQL (D4). Money is integer
 * kobo or cents (D24, N5); a value that is not a whole number fails the read
 * rather than reaching a tile, because a wrong number is worse than none.
 */

const kobo = z.number().int()
const cents = z.number().int()
const count = z.number().int().nonnegative()
/** A timestamp as SQL sends it in JSON, or nothing yet. */
const when = z.string().min(1).nullish()

const salesWindow = z.object({
  netKobo: kobo,
  vatKobo: kobo,
  cashKobo: kobo,
  ordersPaid: count,
  lineRefundedKobo: kobo,
  chargeRefundedKobo: kobo,
})

/** `float_runway` / `admin_float`, in cents (§6 "Float balance", "Burn and runway"). */
export const floatSchema = z.object({
  side: z.enum(['live', 'test']),
  balanceCents: cents.nullish(),
  takenAt: when,
  alertCents: cents.nullish(),
  committedCents: cents,
  uncostedLines: count,
  burn7dCents: cents,
  burn30dCents: cents,
  burnState: z.enum(['known', 'stale', 'short_history']),
  runwayDays: z.number().nonnegative().nullish(),
  lastKnownRunway: z.object({ days: z.number().nonnegative(), at: z.string().min(1) }).nullish(),
  shortByCents: cents.nullish(),
  target21dCents: cents,
  topUpToTargetCents: cents.nullish(),
  ledgerSyncedAt: when,
  ledgerReadAt: when,
})

export type FloatState = z.infer<typeof floatSchema>

const heartbeat = z.object({ name: z.string(), beatAt: when, outcome: z.string().nullish() })

const cronJob = z.object({
  job: z.string(),
  schedule: z.string().nullish(),
  lastRunAt: when,
  lastStatus: z.string().nullish(),
  lastSuccessAt: when,
})

export const healthSchema = z.object({
  heartbeats: z.array(heartbeat),
  reconcile: z.object({ finishedAt: when, error: z.string().nullish() }).nullish(),
  fx: z
    .object({
      activeFrom: when,
      costingRate: z.number().positive().nullish(),
      pendingCount: count,
      pendingOldestAt: when,
    })
    .nullish(),
  snapshotAt: when,
  /** Left out for a test administrator (§3.2h). */
  cron: z.array(cronJob).optional(),
})

export type Health = z.infer<typeof healthSchema>
export type Heartbeat = z.infer<typeof heartbeat>
export type CronJob = z.infer<typeof cronJob>

/** Paid lines by kind over one window (`admin_overview.lines`, migration 42). */
const linesWindow = z.object({ register: count, renew: count, transfer: count, ssl: count })

export const overviewSchema = z.object({
  sales: z.object({ d1: salesWindow, d7: salesWindow, d30: salesWindow, d90: salesWindow }),
  /** Over the same windows as `sales`: paid more than N days ago is out. */
  lines: z.object({ d7: linesWindow, d30: linesWindow, d90: linesWindow }),
  float: floatSchema,
  health: healthSchema,
  signups7d: count,
  expiries30d: count,
  revenueByDay: z.array(z.object({ day: z.string(), netKobo: kobo })),
  balanceByDay: z.array(z.object({ day: z.string(), closeCents: cents.nullish() })),
  renewalsByMonth: z.array(z.object({ month: z.string(), count })),
  domainsByStatus: z.array(z.object({ status: z.string(), count })),
})

export type Overview = z.infer<typeof overviewSchema>
export type SalesWindow = z.infer<typeof salesWindow>
export type LinesWindow = z.infer<typeof linesWindow>

/** The answer as the page reads it, or null when it is not what SQL promised. */
export function parseOverview(data: unknown): { overview: Overview } | { issues: number } {
  const parsed = overviewSchema.safeParse(data)
  return parsed.success ? { overview: parsed.data } : { issues: parsed.error.issues.length }
}
