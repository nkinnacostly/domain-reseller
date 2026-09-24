import type { LocalStatus } from '@dr/shared'
import { daysUntilExpiry, filterPortfolio, type PortfolioDomain } from './portfolio'

/**
 * What the portfolio overview shows (PRD FR-P1, FR-P5). Every figure is
 * counted from the account's own domains and orders — nothing here is a
 * sample or an estimate (N9b).
 */

/** Statuses in which the domain is still the customer's to renew. */
const HELD: ReadonlySet<LocalStatus> = new Set([
  'active',
  'expired_grace',
  'redemption',
  'pending_delete',
  'pending_verification',
])

export type DashboardOrder = { status: string }

export type RenewalMonth = { key: string; label: string; count: number }

export type Summary = {
  /** Every domain in the portfolio, whatever its state. */
  total: number
  active: number
  /** The same count the "Expiring in 30 days" view lists: expired ones included. */
  dueWithin30: number
  dueWithin7: number
  /** Domains still the customer's: the base for the shares below. */
  held: number
  autoRenewOff: number
  /** Share of held domains that renew automatically, 0–100; null with none held. */
  autoRenewShare: number | null
  nameservers: { working: number; waiting: number; notSet: number }
  /** The first held domain not yet pointed at a host, to link straight to it. */
  firstNotPointed: string | null
  /** Renewals falling in each of the next six calendar months, this one first. */
  renewalsByMonth: RenewalMonth[]
  renewalsAhead: number
  /** Held domains, soonest expiry first. */
  upcoming: PortfolioDomain[]
  awaitingPayment: number
}

const LAGOS = 'Africa/Lagos'
const monthKey = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  timeZone: LAGOS,
})
const monthLabel = new Intl.DateTimeFormat('en-NG', { month: 'short', timeZone: LAGOS })

/** The next six calendar months in Lagos, this one first. */
export function nextMonths(now: Date, count = 6): { key: string; label: string }[] {
  const [year, month] = monthKey.format(now).split('-').map(Number) as [number, number]
  return Array.from({ length: count }, (_, index) => {
    // Mid-month at noon UTC is the same month in Lagos, whatever the day.
    const date = new Date(Date.UTC(year, month - 1 + index, 15, 12))
    return { key: monthKey.format(date), label: monthLabel.format(date) }
  })
}

export function summarize(
  domains: PortfolioDomain[],
  orders: DashboardOrder[],
  now: Date,
): Summary {
  const held = domains.filter((domain) => HELD.has(domain.status))
  const within = (days: 7 | 30) => filterPortfolio(domains, { expiringWithin: days }, now).length

  const nameservers = { working: 0, waiting: 0, notSet: 0 }
  let firstNotPointed: string | null = null
  for (const domain of [...held].sort((a, b) => a.domainName.localeCompare(b.domainName))) {
    if (domain.pendingNameservers || domain.delegationStatus === 'pending') {
      nameservers.waiting += 1
    } else if (domain.delegationStatus === 'verified') {
      nameservers.working += 1
    } else {
      nameservers.notSet += 1
      firstNotPointed ??= domain.domainName
    }
  }

  const months = nextMonths(now).map((month) => ({ ...month, count: 0 }))
  for (const domain of held) {
    if (!domain.expiresAt) continue
    const bucket = months.find(
      (month) => month.key === monthKey.format(new Date(domain.expiresAt as string)),
    )
    if (bucket) bucket.count += 1
  }

  const autoRenewOn = held.filter((domain) => domain.autoRenew).length

  return {
    total: domains.length,
    active: domains.filter((domain) => domain.status === 'active').length,
    dueWithin30: within(30),
    dueWithin7: within(7),
    held: held.length,
    autoRenewOff: held.length - autoRenewOn,
    autoRenewShare: held.length ? Math.round((autoRenewOn / held.length) * 100) : null,
    nameservers,
    firstNotPointed,
    renewalsByMonth: months,
    renewalsAhead: months.reduce((sum, month) => sum + month.count, 0),
    upcoming: filterPortfolio(held, {}, now).filter((domain) => domain.expiresAt),
    awaitingPayment: orders.filter((order) => order.status === 'awaiting_payment').length,
  }
}

const hourFormat = new Intl.DateTimeFormat('en-NG', {
  hour: 'numeric',
  hourCycle: 'h23',
  timeZone: LAGOS,
})

/** By the clock in Lagos, where our customers are. */
export function greeting(now: Date): string {
  const hour = Number(hourFormat.format(now))
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

const longDate = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: LAGOS,
})

export function todayLine(now: Date): string {
  return `It’s ${longDate.format(now).replace(',', '')}`
}

/** "in 12 days", "today", "6 days ago" — for a date already known to exist. */
export function relativeDays(expiresAt: string, now: Date): string {
  const days = daysUntilExpiry(expiresAt, now) ?? 0
  if (days === 0) return 'today'
  if (days < 0) return `${-days} ${days === -1 ? 'day' : 'days'} ago`
  return `in ${days} ${days === 1 ? 'day' : 'days'}`
}

/** A person's initials for the avatar, from their name or else their email. */
export function initials(fullName: string, email: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((word) => word[0] ?? '')
      .join('')
      .toUpperCase()
  }
  return (email[0] ?? '?').toUpperCase()
}
