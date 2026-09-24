import { sameNameservers } from '../provisioning/saga'
import type { ResolverView } from './resolvers'

/**
 * What the public resolvers' answers mean for a domain's delegation status
 * (PRD FR-D5). Pure: the checker asks, the database records.
 *
 * - Every resolver sees our nameservers → `verified`.
 * - Every resolver gives the same other answer — other nameservers, no such
 *   domain, or no answer from the nameservers themselves → `failed`. But not
 *   within a day of the nameservers changing: resolvers keep the old
 *   delegation for hours after a change, and FR-D5 surfaces a failure after
 *   24 hours, not before. Until then it is `pending`.
 * - Resolvers disagree with each other: the change is still spreading →
 *   `pending`.
 * - A resolver we could not ask at all (timeout, network) tells us nothing
 *   about the domain, so the status stays what it was: a slow resolver must
 *   not turn a working domain into "waiting to take effect".
 */

export type CheckedStatus = 'verified' | 'failed' | 'pending'
export type CurrentStatus = CheckedStatus | 'undelegated'

export const FAILURE_GRACE_MS = 24 * 3_600_000

export type DelegationInput = {
  /** What the registry has for the domain, as we hold it. */
  nameservers: string[]
  /** Never `undelegated`: a domain on the supplier's defaults is not checked. */
  current: CheckedStatus
  views: ResolverView[]
  /** When the domain's nameservers last changed, if known. */
  changedAt: Date | null
  now: Date
  graceMs?: number
}

/** The status to record. */
export function judgeDelegation(input: DelegationInput): CheckedStatus {
  const { nameservers, current, views, changedAt, now, graceMs = FAILURE_GRACE_MS } = input
  if (views.length === 0 || views.some((view) => view.state === 'no-answer')) return current

  const matches = (view: ResolverView) =>
    view.state === 'answered' && sameNameservers(view.nameservers, nameservers)
  if (views.every(matches)) return 'verified'

  const signature = (view: ResolverView) =>
    view.state === 'answered' ? `answered:${view.nameservers.join(',')}` : view.state
  const [first, ...rest] = views.map(signature)
  const consistent = rest.every((other) => other === first)
  if (!consistent) return 'pending'

  const recentlyChanged = changedAt !== null && now.getTime() - changedAt.getTime() < graceMs
  return recentlyChanged ? 'pending' : 'failed'
}
