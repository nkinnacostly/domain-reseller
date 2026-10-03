import { z } from 'zod'

/**
 * The Pricing & FX pages' data, parsed (docs/ADMIN-SPEC.md §3.2h, §5.2 B12).
 * `admin_pricing_status` answers the settings, the catalogue's counts, the
 * review state of every rate and the worked example's catalogue row, its
 * costs already in whole cents (migration 42, D24); the rate rows add what
 * that answer leaves out (each rate's own buffer, why it was held). Pure: no
 * I/O, so every shape is unit-tested.
 */

/** The extension `admin_pricing_status` prices as its example (fixed in SQL). */
export const SAMPLE_TLD = 'com'

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

/**
 * The extension the pages price as their example (.com), its yearly costs in
 * integer cents as SQL sends them (D24). `onSale` is what the storefront
 * asks: sellable and not paused.
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

const cents = z.number().int().nonnegative()
const periods = z.array(z.number().int().positive()).nullable()

/**
 * `admin_pricing_status.example` (migration 42). SQL sends a cost that is not
 * a whole number of cents as null — a cost rounded to the cent would build a
 * price the site does not charge — and then there is no example (N5b).
 */
const exampleSchema = z
  .object({
    name: z.string().min(1),
    registerCents: cents.nullable(),
    renewCents: cents.nullable(),
    isCountryCode: z.boolean(),
    minPeriod: z.number().int().positive(),
    maxPeriod: z.number().int().positive(),
    registerPeriods: periods,
    renewPeriods: periods,
    isSellable: z.boolean(),
    isPaused: z.boolean(),
  })
  .transform((row): SampleTld | null =>
    row.registerCents === null || row.renewCents === null
      ? null
      : {
          name: row.name,
          registerCents: row.registerCents,
          renewCents: row.renewCents,
          isCountryCode: row.isCountryCode,
          minPeriod: row.minPeriod,
          maxPeriod: row.maxPeriod,
          registerPeriods: row.registerPeriods,
          renewPeriods: row.renewPeriods,
          onSale: row.isSellable && !row.isPaused,
        },
  )

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
  /** None without the row, or with a cost not cent-exact; one that is malformed is none too. */
  example: exampleSchema
    .nullish()
    .transform((example) => example ?? null)
    .catch(null),
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
