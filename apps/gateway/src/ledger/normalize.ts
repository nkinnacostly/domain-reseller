import { usdToCents } from '@dr/shared/admin'
import { z } from 'zod'
import { supplierDate } from '../provisioning/registrar'

/**
 * One supplier ledger entry (`deposit/transactions`) as the mirror stores it
 * (docs/ADMIN-SPEC.md §4.4, §7). Read 2 Oct 2026 on production:
 *
 * - `amount` is always 0. Spend is `balance − oldBalance`, in cents.
 * - `creationTime` has no zone and is UTC+3, like every domain-API date.
 * - Trace ids are GUIDs, not RFC 9562 UUIDs: a top-up's had version nibble
 *   `b` and variant `7`, and debits come upper-case. `z.uuid()` refuses the
 *   first; `z.guid()` takes any 8-4-4-4-12 hex. Stored lower-case.
 *
 * `amount`, `exchange*` and `resellerName` are never read.
 */

export class LedgerReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerReadError'
  }
}

export type LedgerRow = {
  traceId: string
  occurredAt: string
  type: number
  status: number
  chargeType: number
  productType: number
  productId: string | null
  description: string
  period: number | null
  oldBalanceCents: number
  balanceCents: number
}

const guid = z.guid()
const small = z.number().int().min(-32_768).max(32_767)
const money = z.union([z.number(), z.string()])

const itemSchema = z.object({
  traceId: guid,
  creationTime: z.string().min(1),
  type: small,
  status: small,
  chargeType: small,
  productType: small,
  productId: z.unknown().optional(),
  description: z.string().nullish(),
  period: small.nullish(),
  oldBalance: money,
  balance: money,
})

/** A row for record_supplier_ledger, or a LedgerReadError that refuses the whole read. */
export function toLedgerRow(item: unknown): LedgerRow {
  const parsed = itemSchema.safeParse(item)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || 'entry'
    throw new LedgerReadError(`A ledger entry could not be read (${field})`)
  }
  const raw = parsed.data
  const occurredAt = supplierDate(raw.creationTime)
  if (!occurredAt) throw new LedgerReadError('A ledger entry has no readable time')
  const productId =
    typeof raw.productId === 'string' && guid.safeParse(raw.productId).success
      ? raw.productId.toLowerCase()
      : null
  let oldBalanceCents: number
  let balanceCents: number
  try {
    oldBalanceCents = usdToCents(raw.oldBalance)
    balanceCents = usdToCents(raw.balance)
  } catch {
    throw new LedgerReadError('A ledger entry has an unreadable balance')
  }
  return {
    traceId: raw.traceId.toLowerCase(),
    occurredAt,
    type: raw.type,
    status: raw.status,
    chargeType: raw.chargeType,
    productType: raw.productType,
    productId,
    description: (raw.description ?? '').slice(0, 300),
    period: raw.period ?? null,
    oldBalanceCents,
    balanceCents,
  }
}
