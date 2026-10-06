import type { BillingStanding } from '@/features/accounts/lib/state'
import { type BillingOverview, liveSubscription } from './overview'

/** The dashboard banner's billing standing (§8): past due, why, and until when. */
export function billingStanding(overview: BillingOverview | null): BillingStanding {
  const live = overview ? liveSubscription(overview) : null
  if (live?.status !== 'past_due' || !live.pastDueUntil) return null
  return {
    status: 'past_due',
    until: live.pastDueUntil,
    reason: live.pastDueReason ?? 'renewal_failed',
    planName: live.planName,
  }
}
