import { z } from 'zod'
import { domainStemSchema } from '../schemas/index'

/**
 * The availability contract between the web app and the registrar gateway
 * (PRD FR-S1, ADR-004). Both sides parse against these schemas, so a change
 * here is a change to the wire format — and the compiler finds every caller.
 */

/**
 * Bounds per request. A supplier call costs ~0.75s per extension and little
 * per extra name (PRD V4), so extensions are the costly axis. Names are
 * bounded for bulk search (FR-S5), which packs up to this many into one
 * request so its calls grow with blocks of names, not with names.
 */
export const AVAILABILITY_LIMITS = { maxNames: 50, maxTlds: 12 } as const

const tldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})*$/, 'Not an extension')

export const AVAILABILITY_PRIORITIES = ['high', 'normal', 'low'] as const
export type AvailabilityPriority = (typeof AVAILABILITY_PRIORITIES)[number]

export const availabilityRequestSchema = z.object({
  names: z.array(domainStemSchema).min(1).max(AVAILABILITY_LIMITS.maxNames),
  tlds: z.array(tldSchema).min(1).max(AVAILABILITY_LIMITS.maxTlds),
  /**
   * `high` for the one answer a person is watching for — the exact match.
   * `low` for bulk search (FR-S5): it waits behind everything else and never
   * holds both supplier slots. The supplier allows two calls in flight, so
   * this decides who waits.
   */
  priority: z.enum(AVAILABILITY_PRIORITIES).default('normal'),
  /**
   * Ask the supplier even if the 60-second cache has an answer (FR-S6):
   * cached results are re-validated before a name goes into a cart or is paid
   * for (FR-C7, N4). The fresh answer replaces the cached one.
   */
  fresh: z.boolean().default(false),
})
export type AvailabilityRequest = z.input<typeof availabilityRequestSchema>

/**
 * - `available`  — can be registered at the catalogue price
 * - `registered` — someone holds it
 * - `premium`    — the registry prices it individually; we cannot sell it yet
 * - `restricted` — reserved, or breaks the extension's rules (length, etc.)
 * - `unknown`    — the supplier did not answer for it this time
 */
export const AVAILABILITY_STATUS = [
  'available',
  'registered',
  'premium',
  'restricted',
  'unknown',
] as const
export type AvailabilityStatus = (typeof AVAILABILITY_STATUS)[number]

export const availabilityResultSchema = z.object({
  name: z.string(),
  tld: z.string(),
  domain: z.string(),
  status: z.enum(AVAILABILITY_STATUS),
})
export type AvailabilityResult = z.infer<typeof availabilityResultSchema>

export const availabilityResponseSchema = z.object({
  results: z.array(availabilityResultSchema),
})
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>

/**
 * The supplier's prepaid balance, for the float pre-flight before any charge
 * (FR-C8, PRD §13.4 step 3).
 */
export const accountBalanceSchema = z.object({
  balanceUsd: z.number().nonnegative(),
})
export type AccountBalance = z.infer<typeof accountBalanceSchema>
