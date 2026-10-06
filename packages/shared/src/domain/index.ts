/** Domain lifecycle — mirrors PRD §10. The state machine is the source of truth. */
export const LOCAL_STATUS = [
  'pending',
  'active',
  'expired_grace',
  'redemption',
  'pending_delete',
  'released',
  'transferred_away',
  'pending_verification',
  'transfer_requested',
  'transfer_pending',
  'transfer_rejected',
  'transfer_cancelled',
  'registration_failed',
  'closed',
] as const
export type LocalStatus = (typeof LOCAL_STATUS)[number]

export const DELEGATION_STATUS = ['undelegated', 'pending', 'verified', 'failed'] as const
export type DelegationStatus = (typeof DELEGATION_STATUS)[number]

/** Legal transitions. Anything not listed here is a bug, not an edge case. */
const TRANSITIONS: Record<LocalStatus, readonly LocalStatus[]> = {
  pending: ['active', 'registration_failed'],
  active: ['expired_grace', 'transferred_away', 'pending_verification', 'transfer_requested'],
  expired_grace: ['active', 'redemption'],
  redemption: ['active', 'pending_delete'],
  pending_delete: ['released'],
  released: [],
  transferred_away: [],
  pending_verification: ['active', 'closed'],
  // Straight to active when the first registry read finds it already ours: an
  // earlier attempt landed before we could record it (migration 26, I1).
  transfer_requested: ['transfer_pending', 'transfer_cancelled', 'active'],
  transfer_pending: ['active', 'transfer_rejected', 'transfer_cancelled'],
  transfer_rejected: ['transfer_requested'],
  transfer_cancelled: ['transfer_requested'],
  registration_failed: ['closed'],
  closed: [],
}

export function canTransition(from: LocalStatus, to: LocalStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: LocalStatus, to: LocalStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal domain transition: ${from} → ${to}`)
  }
}

/**
 * Whether the registrar has put the name on hold: the registry takes it out of
 * the zone, so websites and email on it stop working. The supplier reports it
 * as status 12, `PendingHold` (the SDK's DOMAIN_STATUS_MAP); seen on a live
 * .com on 6 Oct 2026 while Verisign's RDAP showed `client hold` and public DNS
 * answered NXDOMAIN. It is a registry fact, copied hourly into
 * `domains.registry_status` by the reconcile — not a lifecycle state, so
 * `local_status` stays as it is (the reconcile also opens a `status_mismatch`
 * drift for a person).
 */
export function isRegistryHold(registryStatus: string | null | undefined): boolean {
  return /hold/i.test(registryStatus ?? '')
}

/** Urgency banding drives the visual treatment required by UX-8. */
export type ExpiryUrgency = 'safe' | 'soon' | 'urgent' | 'critical' | 'expired'

export function expiryUrgency(daysRemaining: number): ExpiryUrgency {
  if (daysRemaining < 0) return 'expired'
  if (daysRemaining <= 3) return 'critical'
  if (daysRemaining <= 7) return 'urgent'
  if (daysRemaining <= 30) return 'soon'
  return 'safe'
}

/**
 * Registrars may refuse a transfer for 60 days after registration, after a
 * previous transfer, or after a change of registrant (ICANN Transfer Policy,
 * updated 21 February 2024, in force from 21 August 2025).
 *
 * The Transfer Policy Review recommends 720 hours (30 days) instead. That is
 * approved but not yet in force — change this constant when it is, and every
 * date we show moves with it.
 */
export const TRANSFER_LOCK_DAYS = 60

export function transferEligibleAt(referenceDate: Date): Date {
  const eligible = new Date(referenceDate)
  eligible.setUTCDate(eligible.getUTCDate() + TRANSFER_LOCK_DAYS)
  return eligible
}

export function isTransferEligible(referenceDate: Date, now: Date = new Date()): boolean {
  return now.getTime() >= transferEligibleAt(referenceDate).getTime()
}

/** ERRP notice windows — PRD §7.4. These are compliance artefacts, not marketing. */
export const ERRP_WINDOWS = {
  preExpiryFirst: { minDays: 26, maxDays: 35 },
  preExpirySecond: { minDays: 4, maxDays: 10 },
  postExpiryMaxDays: 5,
} as const

export function errpNoticeDue(
  daysUntilExpiry: number,
): 'errp_pre_35' | 'errp_pre_7' | 'errp_post' | null {
  const { preExpiryFirst, preExpirySecond, postExpiryMaxDays } = ERRP_WINDOWS
  if (daysUntilExpiry >= preExpiryFirst.minDays && daysUntilExpiry <= preExpiryFirst.maxDays) {
    return 'errp_pre_35'
  }
  if (daysUntilExpiry >= preExpirySecond.minDays && daysUntilExpiry <= preExpirySecond.maxDays) {
    return 'errp_pre_7'
  }
  if (daysUntilExpiry < 0 && Math.abs(daysUntilExpiry) <= postExpiryMaxDays) return 'errp_post'
  return null
}
