import { z } from 'zod'
import { domainStemSchema } from '../schemas/index'

/**
 * The availability contract between the web app and the registrar gateway
 * (PRD FR-S1, ADR-004). Both sides parse against these schemas, so a change
 * here is a change to the wire format — and the compiler finds every caller.
 */

/** Bounds per request. Each extension is one supplier call, so TLDs are the costly axis. */
export const AVAILABILITY_LIMITS = { maxNames: 25, maxTlds: 12 } as const

const tldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})*$/, 'Not an extension')

export const availabilityRequestSchema = z.object({
  names: z.array(domainStemSchema).min(1).max(AVAILABILITY_LIMITS.maxNames),
  tlds: z.array(tldSchema).min(1).max(AVAILABILITY_LIMITS.maxTlds),
  /**
   * `high` for the one answer a person is watching for — the exact match.
   * The supplier allows two calls in flight, so this decides who waits.
   */
  priority: z.enum(['high', 'normal']).default('normal'),
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
