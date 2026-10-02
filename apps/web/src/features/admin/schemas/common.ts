import { z } from 'zod'

/**
 * The inputs every admin action shares (docs/ADMIN-SPEC.md §2.4). Validated
 * before anything else runs: no audit note, gateway call or target id comes
 * from unvalidated input.
 */

/** Typed under "Don't include personal details"; 10–500 characters, as SQL requires. */
export const reasonSchema = z
  .string()
  .trim()
  .min(10, 'Give a reason of at least 10 characters.')
  .max(500, 'Keep the reason under 500 characters.')

/** An optional reason: empty is none; anything given is at most 500 characters. */
export const optionalReasonSchema = z
  .string()
  .trim()
  .max(500, 'Keep the reason under 500 characters.')
  .optional()
  .transform((value) => (value ? value : undefined))

/** Made per dialog opening: a retry after a lost answer replays, never repeats. */
export const requestKeySchema = z.uuid()

/** The six digits from the authenticator app, for a money action (D6). */
export const codeSchema = z
  .string()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.')

export const uuidSchema = z.uuid()
export const bigintIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const sideSchema = z.enum(['live', 'test'])

/** A domain or certificate name for a live read; the gateway checks it again. */
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+$/, 'Not a domain name')

/** The input a money action adds to its own: the dialog's code (D6). */
export const moneyInputSchema = z.object({ code: codeSchema })

/** What every admin write carries. */
export const writeInputSchema = z.object({ requestKey: requestKeySchema })
