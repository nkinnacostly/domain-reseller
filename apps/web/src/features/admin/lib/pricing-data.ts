import { usdToCents } from '@dr/shared/admin'
import { z } from 'zod'

/**
 * The Pricing & FX pages' data, parsed (docs/ADMIN-SPEC.md §3.2h, §5.2 B12).
 * `admin_pricing_status` answers the settings, the catalogue's counts and
 * the review state of every rate; the rate rows add what that answer leaves
 * out (each rate's own buffer, why it was held); one catalogue row is the
 * worked example. Pure: no I/O, so every shape is unit-tested.
 */

/** A numeric column as PostgREST sends it: a JSON number (or its text), never a guess. */
const numeric = z
  .union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number().refine(Number.isFinite, 'not a finite number'))

const count = z.number().int().nonnegative()
const timestamp = z.string().min(1)

const settingsSchema = z.object({
  marginNgn: numeric,
  fxBufferPct: numeric,
  icannFeeCents: z.number().int().nonnegative(),
  fxMoveThresholdPct: numeric,
  vatPct: numeric,
})

const activeSchema = z.object({
  id: z.string().min(1),
  costingRate: numeric,
  source: z.string(),
  quotedAt: timestamp,
  effectiveFrom: timestamp.nullable(),
})

const pendingSchema = z.object({
  id: z.string().min(1),
  costingRate: numeric,
  source: z.string(),
  quotedAt: timestamp,
  movePct: numeric.nullable(),
  tooOld: z.boolean(),
  olderThanActive: z.boolean(),
})

const statusSchema = z.object({
  tlds: z.object({
    total: count,
    sellable: count,
    paused: count,
    featured: count,
    transferable: count,
  }),
  ssl: z.object({ total: count, sellable: count, priced: count }),
  fx: z.object({ active: activeSchema.nullable(), pending: z.array(pendingSchema) }),
  settings: settingsSchema.nullable(),
})

export type PricingSettings = z.output<typeof settingsSchema>
export type ActiveRate = z.output<typeof activeSchema>
export type PendingRate = z.output<typeof pendingSchema>
export type PricingStatus = z.output<typeof statusSchema>

/** `admin_pricing_status()`'s answer, or how many things were wrong with it. */
export function parsePricingStatus(json: unknown): { status: PricingStatus } | { issues: number } {
  const parsed = statusSchema.safeParse(json)
  return parsed.success ? { status: parsed.data } : { issues: parsed.error.issues.length }
}

const rateRowSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    source: z.string(),
    costing_rate: numeric,
    buffer_pct: numeric,
    move_pct: numeric.nullable(),
    review_reason: z.string().nullable(),
    quoted_at: timestamp,
    effective_from: timestamp.nullable(),
    created_at: timestamp,
    reviewed_at: timestamp.nullable(),
  })
  .transform((row) => ({
    id: row.id,
    status: row.status,
    source: row.source,
    costingRate: row.costing_rate,
    bufferPct: row.buffer_pct,
    movePct: row.move_pct,
    reviewReason: row.review_reason,
    quotedAt: row.quoted_at,
    effectiveFrom: row.effective_from,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }))

/** One `fx_rates` row, as the FX page shows it. */
export type RateRow = z.output<typeof rateRowSchema>

/** `fx_rates` rows, or null when any of them is not what the table holds. */
export function parseRateRows(rows: unknown): RateRow[] | null {
  const parsed = z.array(rateRowSchema).safeParse(rows)
  return parsed.success ? parsed.data : null
}

/**
 * Whole cents, but only when that is exactly the amount: the catalogue holds
 * four decimal places, and a cost rounded to the cent would build a price
 * the site does not charge. Null then, and the example is left out — a wrong
 * number is worse than none (N5b).
 */
export function exactCents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  let cents: number
  try {
    cents = usdToCents(value)
  } catch {
    return null
  }
  return cents >= 0 && cents / 100 === Number(value) ? cents : null
}

const periods = z.array(z.coerce.number().int()).nullable()

const sampleRowSchema = z.object({
  name: z.string().min(1),
  register_usd: z.union([z.number(), z.string()]),
  renew_usd: z.union([z.number(), z.string()]),
  is_country_code: z.boolean(),
  min_period: z.coerce.number().int(),
  max_period: z.coerce.number().int(),
  register_periods: periods.optional(),
  renew_periods: periods.optional(),
  is_sellable: z.boolean(),
  is_paused: z.boolean(),
})

/**
 * The extension the pages price as their example (.com), in integer cents
 * from the catalogue's dollars at the edge (D24). `onSale` is what the
 * storefront asks: sellable and not paused.
 */
export type SampleTld = {
  name: string
  registerCents: number
  renewCents: number
  isCountryCode: boolean
  minPeriod: number
  maxPeriod: number
  registerPeriods: number[] | null
  renewPeriods: number[] | null
  onSale: boolean
}

/** A `tlds` row as the example, or null when it is missing, malformed or not cent-exact. */
export function parseSampleTld(row: unknown): SampleTld | null {
  const parsed = sampleRowSchema.safeParse(row)
  if (!parsed.success) return null
  const data = parsed.data
  const registerCents = exactCents(data.register_usd)
  const renewCents = exactCents(data.renew_usd)
  if (registerCents === null || renewCents === null) return null
  return {
    name: data.name,
    registerCents,
    renewCents,
    isCountryCode: data.is_country_code,
    minPeriod: data.min_period,
    maxPeriod: data.max_period,
    registerPeriods: data.register_periods ?? null,
    renewPeriods: data.renew_periods ?? null,
    onSale: data.is_sellable && !data.is_paused,
  }
}
