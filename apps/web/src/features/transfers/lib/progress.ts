import type { LocalStatus } from '@dr/shared'

/**
 * Where a transfer in stands, in the customer's words (PRD E9). A transfer
 * waits days on the other registrar, so the list says what happens next
 * rather than only naming a state.
 */

export type TransferStage = 'waiting' | 'at_registry' | 'done' | 'not_transferred'

export function transferStage(status: LocalStatus): TransferStage {
  switch (status) {
    case 'transfer_requested':
      return 'waiting'
    case 'transfer_pending':
      return 'at_registry'
    case 'transfer_rejected':
    case 'transfer_cancelled':
      return 'not_transferred'
    default:
      // Active, expiring, and every later state: it arrived.
      return 'done'
  }
}

export function isTransferOpen(stage: TransferStage): boolean {
  return stage === 'waiting' || stage === 'at_registry'
}

export const STAGE_NOTE: Record<TransferStage, (testMode: boolean) => string> = {
  waiting: () => 'Paid. We send the request to the registry shortly.',
  at_registry: () =>
    'The registry has the request. Transfers usually finish within 5 days; your current registrar may email the owner to approve it.',
  done: (testMode) =>
    testMode ? 'Transferred in the registrar’s test system.' : 'Transferred. It’s on your account.',
  not_transferred: (testMode) =>
    testMode
      ? 'The transfer didn’t go through. This was a test payment, so no money moved.'
      : 'The transfer didn’t go through. What you paid is refunded automatically — the order shows its progress.',
}
