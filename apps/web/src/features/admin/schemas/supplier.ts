import { z } from 'zod'
import { MAX_NGN_PAID_KOBO } from '@/features/admin/lib/supplier-topups'
import {
  bigintIdSchema,
  codeSchema,
  optionalReasonSchema,
  reasonSchema,
  requestKeySchema,
} from './common'

/**
 * The Supplier pages' action inputs (docs/ADMIN-SPEC.md §5.2 B6), validated
 * before anything else runs: no audit note, gateway call or wrapper sees an
 * unchecked value (§2.4).
 */

/** A supplier trace id: any 8-4-4-4-12 GUID, either case, lower-cased (§7). */
export const traceIdSchema = z
  .guid('Not a ledger trace id')
  .transform((value) => value.toLowerCase())

export const ngnPaidKoboSchema = z
  .number()
  .int('Enter the naira paid, more than zero, with at most two decimal places.')
  .positive('Enter the naira paid, more than zero, with at most two decimal places.')
  .max(MAX_NGN_PAID_KOBO, 'That is more than any top-up the dashboard records.')

export const topupReferenceSchema = z
  .string()
  .trim()
  .min(1, 'Give the payment reference in 1 to 80 characters.')
  .max(80, 'Give the payment reference in 1 to 80 characters.')

/** Apply a price list now (money, owner): the dialog's code and key; a reason if given. */
export const applyCatalogueSchema = z.object({
  code: codeSchema,
  requestKey: requestKeySchema,
  reason: optionalReasonSchema,
})

/** Preview a price list (standard, owner): nothing to give. */
export const previewCatalogueSchema = z.object({})

export const recordTopupSchema = z.object({
  traceId: traceIdSchema,
  ngnPaidKobo: ngnPaidKoboSchema,
  reference: topupReferenceSchema,
  reason: reasonSchema,
  requestKey: requestKeySchema,
  code: codeSchema,
})

export const correctTopupSchema = z.object({
  topupId: bigintIdSchema,
  ngnPaidKobo: ngnPaidKoboSchema,
  reference: topupReferenceSchema,
  reason: reasonSchema,
  requestKey: requestKeySchema,
  code: codeSchema,
})
