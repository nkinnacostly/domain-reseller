/**
 * Plan maths (MAIL-SPEC §7.2, §7.3, §8, §4.4). Prices and caps are rows in
 * `mail.plans` and `mail.settings`, never constants here (N5b); these
 * functions take them as input. SQL decides every send (`mail.effective_caps`,
 * `mail.reserve_send`); this mirror words the dashboard and the pricing page,
 * and its tests pin the same rules.
 *
 * Caps count recipients, as SES does: an email to three people is three.
 */

export type AccountState = 'sandbox' | 'active' | 'paused' | 'closed'

export type PlanCaps = { dailyCap: number; monthlyCap: number }

export type CapSettings = {
  /** §7.2: 100 a day in the sandbox. */
  sandboxDailyCap: number
  /** §7.3: an approved account's first day. */
  warmupStartCap: number
}

export type AccountCaps = {
  state: AccountState
  /** Days of warm-up since approval; null before approval or once an admin sets the caps. */
  warmupDay: number | null
  dailyCapOverride: number | null
  monthlyCapOverride: number | null
}

/** §7.3: the warm-up cap for a day — the start, doubled each day. */
export function warmupCap(day: number, startCap: number): number {
  return startCap * 2 ** Math.min(Math.max(0, Math.floor(day)), 30)
}

/** The caps that apply today. Paused and closed accounts send nothing. */
export function effectiveCaps(
  plan: PlanCaps,
  account: AccountCaps,
  settings: CapSettings,
): { daily: number; monthly: number } {
  if (account.state === 'paused' || account.state === 'closed') return { daily: 0, monthly: 0 }
  const monthly = account.monthlyCapOverride ?? plan.monthlyCap
  let daily = account.dailyCapOverride ?? plan.dailyCap
  if (account.state === 'sandbox') {
    daily = Math.min(daily, settings.sandboxDailyCap)
  } else if (account.warmupDay !== null && account.dailyCapOverride === null) {
    daily = Math.min(daily, warmupCap(account.warmupDay, settings.warmupStartCap))
  }
  return { daily: Math.min(daily, monthly), monthly }
}

/** §7.3: a day of warm-up passes only with bounces under 2% and complaints under 0.05%. */
export const WARMUP_LIMITS = { bounceRate: 0.02, complaintRate: 0.0005 } as const

export type DayOfSending = { sent: number; bounced: number; complained: number }

/**
 * The next warm-up day: one more after a clean day, the same after a day
 * over either rate. A day with nothing sent proves nothing and moves nothing.
 */
export function nextWarmupDay(day: number, yesterday: DayOfSending): number {
  if (yesterday.sent <= 0) return day
  const bounceRate = yesterday.bounced / yesterday.sent
  const complaintRate = yesterday.complained / yesterday.sent
  return bounceRate < WARMUP_LIMITS.bounceRate && complaintRate < WARMUP_LIMITS.complaintRate
    ? day + 1
    : day
}

/**
 * §4.4: what one account may still reserve of the SES account's shared
 * 24-hour budget — no more than half of what the other accounts leave
 * (owner, 6 Oct 2026), and never past the budget itself.
 */
export function budgetAllowance(budget: number, total: number, mine: number): number {
  const others = total - mine
  const half = Math.floor((budget - others) / 2)
  return Math.max(0, Math.min(budget - total, half - mine))
}

/** §8: a banner and an email at 80% of a cap; `quota_exceeded` at 100%. */
export function capLevel(used: number, cap: number): 'ok' | 'warning' | 'reached' {
  if (cap <= 0 || used >= cap) return 'reached'
  return used >= cap * 0.8 ? 'warning' : 'ok'
}

/** §4.4: a paid plan keeps sending when the SES account's day is nearly spent. */
export const isPaidPlan = (priceKobo: number): boolean => priceKobo > 0
