import { z } from 'zod'
import { floatSchema } from './overview-data'

/**
 * What the Supplier page's SQL reads answer (docs/ADMIN-SPEC.md §3.2b, §3.2h,
 * §5.2 B6): `admin_float` — the overview's float plus the top-ups — and
 * `admin_ledger_daily`. Money is integer cents or kobo (D24, N5): a value
 * that is not a whole number fails the read rather than reaching a tile.
 */

const cents = z.number().int()
const kobo = z.number().int()
const when = z.string().min(1)

/**
 * One ledger credit shaped like a top-up, with what it cost in naira when the
 * owner recorded it (live side only). `id` is the current `float_topups` row;
 * without one, nothing is recorded yet. The rate is SQL's numeric
 * `ngn_paid_kobo / usd_cents` — kobo per cent, which is naira per dollar.
 */
export const topupSchema = z.object({
  id: z.number().int().positive().nullish(),
  traceId: z.string().min(1),
  occurredAt: when,
  usdCents: cents,
  ngnPaidKobo: kobo.nullish(),
  rateKoboPerCent: z.number().nonnegative().nullish(),
  reference: z.string().nullish(),
  supersedesId: z.number().int().positive().nullish(),
  recordedBy: z.string().nullish(),
})

export type Topup = z.infer<typeof topupSchema>

/** `admin_float`: the overview's float figures, and the latest top-ups. */
export const supplierFloatSchema = floatSchema.extend({
  topups: z.array(topupSchema).catch([]),
})

export type SupplierFloat = z.infer<typeof supplierFloatSchema>

export function parseSupplierFloat(data: unknown): SupplierFloat | { issues: number } {
  const parsed = supplierFloatSchema.safeParse(data)
  return parsed.success ? parsed.data : { issues: parsed.error.issues.length }
}

/** One Lagos day of the mirror: settled debits and credits, and the last balance. */
export const ledgerDaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  debit_cents: cents,
  credit_cents: cents,
  close_cents: cents.nullable(),
})

export type LedgerDay = {
  day: string
  debitCents: number
  creditCents: number
  closeCents: number | null
}

export function parseLedgerDays(data: unknown): LedgerDay[] | null {
  const parsed = z.array(ledgerDaySchema).safeParse(data)
  if (!parsed.success) return null
  return parsed.data.map((row) => ({
    day: row.day.slice(0, 10),
    debitCents: row.debit_cents,
    creditCents: row.credit_cents,
    closeCents: row.close_cents,
  }))
}
