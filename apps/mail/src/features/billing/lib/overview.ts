import { isMemberRole, type MemberRole } from '@/lib/safe-action'

/**
 * `mail.billing_overview` (migration 50) as the billing page reads it. Every
 * amount was worked out in SQL from `mail.plans` and `mail.billing_settings`
 * (N5b); this only checks the shape, and an answer it cannot read is null —
 * the page's error state, never a guessed price.
 */

export const PLAN_CHANGES = [
  'current',
  'subscribe',
  'upgrade',
  'downgrade',
  'cancel',
  'pay',
  'none',
] as const
export type PlanChange = (typeof PLAN_CHANGES)[number]

export type Quote = {
  change: PlanChange
  priceKobo: number
  /** An upgrade's credit for the unused part of the current month, before VAT. */
  creditKobo: number
  subtotalKobo: number
  vatBps: number
  vatKobo: number
  /** What is paid now. */
  totalKobo: number
  /** What Flutterwave charges each month afterwards (price + VAT). */
  recurringKobo: number
  fromPlanCode: string | null
}

export type PlanOption = {
  code: string
  name: string
  priceKobo: number
  monthlyCap: number
  dailyCap: number
  maxDomains: number
  maxMembers: number
  logRetentionDays: number
  quote: Quote
}

export type SubscriptionStatus = 'active' | 'past_due' | 'ended'
export type PastDueReason = 'renewal_failed' | 'payment_needed'

export type Subscription = {
  status: SubscriptionStatus
  planCode: string
  planName: string
  testMode: boolean
  priceKobo: number
  vatBps: number
  amountKobo: number
  currentPeriodStart: Date
  currentPeriodEnd: Date
  scheduledPlanCode: string | null
  scheduledPlanName: string | null
  pastDueReason: PastDueReason | null
  pastDueUntil: Date | null
  endedReason: 'canceled' | 'lapsed' | null
  /** Owners and admins only: the card's last four digits and its scheme. */
  card: { last4: string; brand: string | null } | null
}

export type BillingOverview = {
  role: MemberRole
  canManage: boolean
  vatBps: number
  pastDueDays: number
  plan: { code: string; name: string; priceKobo: number } | null
  subscription: Subscription | null
  plans: PlanOption[]
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const kobo = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

function date(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

const isChange = (value: unknown): value is PlanChange =>
  typeof value === 'string' && (PLAN_CHANGES as readonly string[]).includes(value)

function readQuote(value: unknown): Quote | null {
  if (!isObject(value) || !isChange(value.change)) return null
  const amounts = [
    kobo(value.priceKobo),
    kobo(value.creditKobo),
    kobo(value.subtotalKobo),
    count(value.vatBps),
    kobo(value.vatKobo),
    kobo(value.totalKobo),
    kobo(value.recurringKobo),
  ]
  if (amounts.some((n) => n === null)) return null
  const [priceKobo, creditKobo, subtotalKobo, vatBps, vatKobo, totalKobo, recurringKobo] =
    amounts as number[]
  return {
    change: value.change,
    priceKobo: priceKobo as number,
    creditKobo: creditKobo as number,
    subtotalKobo: subtotalKobo as number,
    vatBps: vatBps as number,
    vatKobo: vatKobo as number,
    totalKobo: totalKobo as number,
    recurringKobo: recurringKobo as number,
    fromPlanCode: text(value.fromPlanCode),
  }
}

function readPlan(value: unknown): PlanOption | null {
  if (!isObject(value)) return null
  const code = text(value.code)
  const name = text(value.name)
  const quote = readQuote(value.quote)
  const numbers = [
    kobo(value.priceKobo),
    count(value.monthlyCap),
    count(value.dailyCap),
    count(value.maxDomains),
    count(value.maxMembers),
    count(value.logRetentionDays),
  ]
  if (!code || !name || !quote || numbers.some((n) => n === null)) return null
  const [priceKobo, monthlyCap, dailyCap, maxDomains, maxMembers, logRetentionDays] =
    numbers as number[]
  return {
    code,
    name,
    priceKobo: priceKobo as number,
    monthlyCap: monthlyCap as number,
    dailyCap: dailyCap as number,
    maxDomains: maxDomains as number,
    maxMembers: maxMembers as number,
    logRetentionDays: logRetentionDays as number,
    quote,
  }
}

function readSubscription(value: unknown): Subscription | null | undefined {
  if (value === null || value === undefined) return null
  if (!isObject(value)) return undefined
  const status = value.status
  if (status !== 'active' && status !== 'past_due' && status !== 'ended') return undefined
  const planCode = text(value.planCode)
  const start = date(value.currentPeriodStart)
  const end = date(value.currentPeriodEnd)
  const priceKobo = kobo(value.priceKobo)
  const amountKobo = kobo(value.amountKobo)
  const vatBps = count(value.vatBps)
  if (!planCode || !start || !end || priceKobo === null || amountKobo === null || vatBps === null) {
    return undefined
  }
  const reason = value.pastDueReason
  const card = isObject(value.card) && /^\d{4}$/.test(String(value.card.last4)) ? value.card : null
  return {
    status,
    planCode,
    planName: text(value.planName) ?? planCode,
    testMode: value.testMode === true,
    priceKobo,
    vatBps,
    amountKobo,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    scheduledPlanCode: text(value.scheduledPlanCode),
    scheduledPlanName: text(value.scheduledPlanName),
    pastDueReason: reason === 'renewal_failed' || reason === 'payment_needed' ? reason : null,
    pastDueUntil: date(value.pastDueUntil),
    endedReason:
      value.endedReason === 'canceled' || value.endedReason === 'lapsed' ? value.endedReason : null,
    card: card ? { last4: String(card.last4), brand: text(card.brand) } : null,
  }
}

export function readBillingOverview(value: unknown): BillingOverview | null {
  if (!isObject(value) || value.ok !== true || !isMemberRole(value.role)) return null
  const vatBps = count(value.vatBps)
  const pastDueDays = count(value.pastDueDays)
  const subscription = readSubscription(value.subscription)
  if (vatBps === null || pastDueDays === null || subscription === undefined) return null
  if (!Array.isArray(value.plans)) return null
  const plans = value.plans.map(readPlan)
  if (plans.some((plan) => plan === null)) return null
  const plan = isObject(value.plan) ? value.plan : null
  const planCode = text(plan?.code)
  const planPrice = kobo(plan?.priceKobo)
  return {
    role: value.role,
    canManage: value.canManage === true,
    vatBps,
    pastDueDays,
    plan:
      plan && planCode && planPrice !== null
        ? { code: planCode, name: text(plan.name) ?? planCode, priceKobo: planPrice }
        : null,
    subscription,
    plans: plans as PlanOption[],
  }
}

/** The subscription that is paying for this account now, if any. */
export const liveSubscription = (overview: BillingOverview): Subscription | null =>
  overview.subscription && overview.subscription.status !== 'ended' ? overview.subscription : null
