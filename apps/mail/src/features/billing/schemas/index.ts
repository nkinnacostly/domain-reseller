import { z } from 'zod'

/** Billing's inputs. Amounts are integer kobo (N5); plan codes are mail.plans' shape. */

const accountId = z.uuid()
const planCode = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, 'Choose a plan')

/** The total the person was shown: SQL starts nothing if the quote is no longer it. */
export const startCheckoutSchema = z.object({
  accountId,
  planCode,
  expectedTotalKobo: z.number().int().positive().max(100_000_000_000),
})

export const scheduleChangeSchema = z.object({ accountId, planCode })

export const keepPlanSchema = z.object({ accountId })
