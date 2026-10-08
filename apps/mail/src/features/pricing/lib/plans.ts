import type { Database } from '@dr/db'
import { formatNaira } from '@dr/shared/pricing'

/**
 * Mail's plans as the pricing page shows them (MAIL-SPEC §8). Every number
 * comes from a `mail.plans` row — prices and caps are never constants in
 * code (N5b) — and only the plans the SES account can carry are shown:
 * `is_offered` is false for Scale until AWS raises the account's quota
 * (§4.4, owner 6 Oct 2026). Pure: the rows come in, so tests need no network.
 */

export type PlanRow = Pick<
  Database['mail']['Tables']['plans']['Row'],
  | 'code'
  | 'name'
  | 'price_kobo'
  | 'monthly_cap'
  | 'daily_cap'
  | 'max_domains'
  | 'max_members'
  | 'log_retention_days'
  | 'is_offered'
  | 'sort_order'
  | 'updated_at'
>

export type Plan = {
  code: string
  name: string
  /** A month, before VAT, in kobo (N5). */
  priceKobo: number
  /** Caps count recipients, as SES does: an email to three people is three. */
  monthlyCap: number
  dailyCap: number
  maxDomains: number
  maxMembers: number
  logRetentionDays: number
}

export type PlanCatalogue = {
  plans: Plan[]
  /**
   * When the newest offered row last changed (ISO 8601): the pricing page's
   * true "last modified" for the sitemap. Null with no plans.
   */
  updatedAt: string | null
}

/** The offered plans, cheapest first as the database orders them. */
export function toCatalogue(rows: readonly PlanRow[]): PlanCatalogue {
  const offered = rows
    .filter((row) => row.is_offered)
    .sort((a, b) => a.sort_order - b.sort_order || a.price_kobo - b.price_kobo)
  const updatedAt = offered.reduce<string | null>(
    (latest, row) =>
      latest === null || Date.parse(row.updated_at) > Date.parse(latest) ? row.updated_at : latest,
    null,
  )
  return {
    plans: offered.map((row) => ({
      code: row.code,
      name: row.name,
      priceKobo: row.price_kobo,
      monthlyCap: row.monthly_cap,
      dailyCap: row.daily_cap,
      maxDomains: row.max_domains,
      maxMembers: row.max_members,
      logRetentionDays: row.log_retention_days,
    })),
    updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(),
  }
}

const COUNT = new Intl.NumberFormat('en-NG')

/** 50000 → "50,000". */
export const formatCount = (value: number): string => COUNT.format(value)

const plural = (count: number, one: string, many: string) =>
  `${formatCount(count)} ${count === 1 ? one : many}`

export const isFree = (plan: Pick<Plan, 'priceKobo'>): boolean => plan.priceKobo === 0

/** "₦20,000" — the monthly price before VAT. */
export const planPrice = (plan: Pick<Plan, 'priceKobo'>): string => formatNaira(plan.priceKobo)

/**
 * What a plan includes, one line each, in the page's words. The same lines
 * go into the structured data, so markup never says more than the page.
 */
export function planFeatures(plan: Plan): string[] {
  return [
    `${plural(plan.monthlyCap, 'email', 'emails')} a month`,
    `Up to ${formatCount(plan.dailyCap)} a day`,
    plural(plan.maxDomains, 'sending domain', 'sending domains'),
    plural(plan.maxMembers, 'team member', 'team members'),
    `Email log kept ${plural(plan.logRetentionDays, 'day', 'days')}`,
    // Not a plan row: every plan sends both ways (MAIL-SPEC §6, "SMTP").
    'Send by API or SMTP',
  ]
}

/** One sentence for a plan: its price and what it includes. */
export function planSummary(plan: Plan): string {
  const price = isFree(plan) ? 'Free' : `${planPrice(plan)} a month before VAT`
  return `${plan.name}: ${price}. ${planFeatures(plan).join('; ')}.`
}

/** The cheapest paid plan, for "paid plans from …". Null when none is offered. */
export function cheapestPaid(plans: readonly Plan[]): Plan | null {
  return plans.filter((plan) => !isFree(plan)).sort((a, b) => a.priceKobo - b.priceKobo)[0] ?? null
}

/** The free plan, if one is offered. */
export function freePlan(plans: readonly Plan[]): Plan | null {
  return plans.find(isFree) ?? null
}
