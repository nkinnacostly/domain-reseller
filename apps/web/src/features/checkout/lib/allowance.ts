import { z } from 'zod'

/**
 * The daily domain allowance (PRD SEC-11): how many domains an account may
 * register or transfer in over 24 hours, and the tier that sets it. Stolen
 * cards buy domains in bulk for phishing, so a new account starts low and the
 * cap rises by itself with account age and paid orders.
 *
 * Every number comes from `account_domain_allowance()` (migration 32), which
 * reads the tiers from `ops_settings` — so what we tell the customer is what
 * the database will do, and changes with it (N9b).
 */

/** The database function's answer. Anything else fails closed. */
export const allowanceSchema = z.object({
  ordered: z.number().int().nonnegative(),
  max: z.number().int().positive(),
  tier: z.enum(['new', 'standard', 'trusted']),
  paid_orders: z.number().int().nonnegative(),
  account_days: z.number().int().nonnegative(),
  standard_after_days: z.number().int().nonnegative(),
  trusted_after_days: z.number().int().nonnegative(),
  trusted_after_paid_orders: z.number().int().nonnegative(),
})
export type Allowance = z.infer<typeof allowanceSchema>

/** The allowance, or null when the answer is not what we expect. */
export function parseAllowance(data: unknown): Allowance | null {
  const parsed = allowanceSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** Whether adding `adding` domains would take the account past its cap. */
export function exceedsAllowance(allowance: Allowance, adding: number): boolean {
  return allowance.ordered + adding > allowance.max
}

const WEEKS = ['a week', 'two weeks', 'three weeks', 'four weeks']

/** An account age as people say it: "a day", "a week", "30 days". */
export function accountAge(days: number): string {
  if (days === 1) return 'a day'
  if (days > 0 && days % 7 === 0 && days / 7 <= WEEKS.length) return WEEKS[days / 7 - 1] as string
  return `${days} days`
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/**
 * What raises the cap from here, or null on the top tier. A new account moves
 * up with its first paid order or its age; a standard one needs both age and
 * paid orders (migration 32). Only what is still missing is named.
 */
export function nextTier(allowance: Allowance): string | null {
  if (allowance.tier === 'new') {
    return allowance.standard_after_days > 0
      ? `That rises after your first paid order, or once your account is ${accountAge(allowance.standard_after_days)} old.`
      : 'That rises after your first paid order.'
  }
  if (allowance.tier === 'standard') {
    const needsAge = allowance.account_days < allowance.trusted_after_days
    const ordersToGo = allowance.trusted_after_paid_orders - allowance.paid_orders
    const age = `once your account is ${accountAge(allowance.trusted_after_days)} old`
    if (needsAge && ordersToGo > 0) {
      return `That rises ${age} and has ${plural(allowance.trusted_after_paid_orders, 'paid order')}.`
    }
    if (needsAge) return `That rises ${age}.`
    if (ordersToGo > 0) return `That rises after ${plural(ordersToGo, 'more paid order')}.`
  }
  return null
}

/**
 * Why an order or a transfer would go past the daily cap, and what to do —
 * with the account's own numbers. `notCharged` sits between the two, the way
 * every checkout refusal reads. Registrations and transfers in both count
 * (migration 32); renewals never do.
 */
export function allowanceRefusal(
  allowance: Allowance,
  {
    adding,
    kind,
    email,
    notCharged,
  }: { adding: number; kind: 'order' | 'transfer'; email: string; notCharged: string },
): string {
  const who = allowance.tier === 'new' ? 'New accounts' : 'Your account'
  const counted = kind === 'transfer' ? ', transfers in included' : ''
  const full = allowance.ordered >= allowance.max
  const where = full
    ? `you have ordered ${allowance.ordered} in the last 24 hours`
    : `this would take you to ${allowance.ordered + adding}`
  const limit = `${who} can order up to ${plural(allowance.max, 'domain')} a day${counted}, and ${where}.`

  // Room left today means a smaller cart goes through; none means waiting,
  // since the count is of the last 24 hours, not a calendar day.
  const excess = allowance.ordered + adding - allowance.max
  const next = full
    ? `Each order stops counting 24 hours after it was placed, so try again later, or email ${email} to raise your limit.`
    : `Remove ${plural(excess, 'domain')} from your cart, or email ${email} to raise your limit.`

  return [limit, nextTier(allowance), notCharged, next].filter(Boolean).join(' ')
}
