import { TRANSFER_LOCK_DAYS, type TransferRefusal } from '@dr/shared'
import { type LineCost, lineCostUsd, type UsdAmount } from '@/features/checkout/lib/cost'
import type { TransferVerdict } from './eligibility'

/**
 * Whether a transfer can be started and paid for (PRD FR-T1, FR-T2). Pure,
 * so every rule is testable. The registry lookup (RDAP) rules out what it
 * can see; the supplier's check with the transfer code is the final word,
 * asked just before the payment (N4).
 */

export type Startability = { ok: true } | { ok: false; reason: string }

/**
 * What the registry lookup allows. Items the owner must confirm themselves do
 * not stop a transfer: the supplier's check covers them before any money moves.
 */
export function canStartTransfer(verdict: TransferVerdict): Startability {
  switch (verdict.outcome) {
    case 'ready':
    case 'needs-confirmation':
      return { ok: true }
    case 'not-registered':
      return {
        ok: false,
        reason: `Nobody has registered ${verdict.domain}, so there is nothing to transfer — you can register it instead.`,
      }
    case 'unsupported-extension':
      return { ok: false, reason: `We don’t take transfers for .${verdict.tld} yet.` }
    case 'blocked': {
      const blocker = verdict.checks.find((check) => check.state === 'fail')
      return {
        ok: false,
        reason: `${verdict.domain} can’t be transferred yet. ${blocker?.detail ?? ''}`.trim(),
      }
    }
  }
}

/** The supplier's reason, in words for the person holding the code (N10, UX-7). */
export const TRANSFER_REFUSAL_MESSAGE: Record<TransferRefusal, string> = {
  AUTH_CODE_INVALID:
    'Your current registrar didn’t accept that transfer code. Check it — codes are case-sensitive — or ask them for a new one.',
  TRANSFER_LOCKED:
    'The domain is locked at its current registrar. Turn off the transfer lock in their dashboard, then try again.',
  NOT_TRANSFERABLE: `The registry won’t let this domain move right now — for example because it was registered or moved in the last ${TRANSFER_LOCK_DAYS} days, or has expired. The transfer check shows what is in the way.`,
}

/**
 * What the transfer costs us at the supplier, in integer cents — for the
 * float pre-flight (FR-C8) and the line's `order_item_costs` row (ADMIN-SPEC
 * §6): the transfer price, plus the ICANN fee on generic extensions, which a
 * transfer pays once, like a year's renewal (PRD §7.6), split out.
 */
export function transferCostUsd(
  cost: { transferUsd: UsdAmount; isCountryCode: boolean },
  icannFeeUsd: UsdAmount,
): LineCost {
  return lineCostUsd({ kind: 'transfer', ...cost }, icannFeeUsd)
}

/**
 * Whether the catalogue says we take transfers for an extension. The supplier
 * sends no transfer flag, so the catalogue sync derives `is_transferable`
 * from a transfer price; until it has said yes, the answer is no (N5b).
 */
export function takesTransfers(tld: {
  is_transferable: boolean | null
  transfer_usd: number | string | null
}): boolean {
  return tld.is_transferable === true && Number(tld.transfer_usd) > 0
}

/** Local statuses in which we already hold the name — it has nowhere to transfer from. */
export const HELD_HERE = [
  'active',
  'expired_grace',
  'redemption',
  'pending_delete',
  'pending_verification',
] as const

/** A transfer in of this name already paid for and under way on the account. */
export const TRANSFER_UNDER_WAY = ['transfer_requested', 'transfer_pending'] as const
