import { z } from 'zod'
import { domainNameSchema } from '../schemas/index'

/**
 * The transfer-in check between the web app and the registrar gateway (PRD
 * FR-T1, N4): the customer's transfer code is checked with the supplier
 * before any money moves. The answer is a yes or a reason — never the code
 * and never the supplier's own words (N10, N13).
 */

/** Why the supplier will not take a domain from its current registrar now. */
export const TRANSFER_REFUSALS = [
  'AUTH_CODE_INVALID',
  'TRANSFER_LOCKED',
  'NOT_TRANSFERABLE',
] as const
export type TransferRefusal = (typeof TRANSFER_REFUSALS)[number]

/**
 * The transfer (EPP / auth) code as typed or pasted. Registries issue short
 * printable strings; `transfer_secrets` holds at most 255 characters.
 */
export const authCodeSchema = z
  .string()
  .trim()
  .min(1, 'Enter the transfer code from your current registrar')
  .max(255, 'That is longer than any transfer code — check what you pasted')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Paste the code on its own')

export const transferCheckRequestSchema = z.object({
  domainName: domainNameSchema,
  authCode: authCodeSchema,
  /** Test orders are checked in the sandbox, live ones at the live registry — never crossed. */
  testMode: z.boolean(),
})
export type TransferCheckRequest = z.input<typeof transferCheckRequestSchema>

export const transferCheckResultSchema = z.union([
  z.object({ transferable: z.literal(true) }),
  z.object({ transferable: z.literal(false), reason: z.enum(TRANSFER_REFUSALS) }),
])
export type TransferCheckResult = z.infer<typeof transferCheckResultSchema>
