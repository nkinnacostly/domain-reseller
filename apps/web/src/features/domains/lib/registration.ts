import type { LocalStatus } from '@dr/shared'
import { failureReason } from '@dr/shared/email'

/**
 * What the panel says about a domain's registration and a waiting
 * nameserver change. Copy describes what the system does (N9b): test
 * payments are registered in the supplier's sandbox (DNA_WRITE_ENV=ote),
 * never the live registry, and demo domains never reach a registry at all.
 */

type Subject = {
  status: LocalStatus
  source: 'registration' | 'transfer' | 'demo'
  testMode: boolean
  failureCode?: string | null
}

export type Note = { title: string; body: string }

/** PRD §13.8, in words for the person who paid (N10) — the emails say the same. */
export { failureReason }

/** A transfer in that is not finished: no expiry, no nameservers of ours yet (PRD E9). */
export function isTransferInProgress(status: LocalStatus): boolean {
  return status === 'transfer_requested' || status === 'transfer_pending'
}

/**
 * What stands in for the expiry date of a transfer in that has none with us:
 * it is read from the registry when the transfer lands (FR-T3). Null for
 * anything that is not a transfer.
 */
export function transferExpiryText(domain: Pick<Subject, 'status' | 'source'>): string | null {
  if (domain.source !== 'transfer') return null
  return isTransferInProgress(domain.status) ? 'After the transfer' : 'Not transferred'
}

/**
 * A transfer in, step by step (FR-T3). Done only when the registry shows it
 * active in our account; until then the page says who it is waiting on.
 */
function transferNote(domain: Subject): Note | null {
  const refund = domain.testMode
    ? 'This was a test payment, so no money moved.'
    : 'We’ll refund what you paid for it.'
  switch (domain.status) {
    case 'transfer_requested':
      return domain.testMode
        ? {
            title: 'Transfer starting in the sandbox.',
            body: 'This was a test payment, so the request goes to the registrar’s test system, not the live registry.',
          }
        : {
            title: 'Transfer starting.',
            body: 'Your payment is in and the request to the registry is queued. This page shows each step.',
          }
    case 'transfer_pending':
      return {
        title: 'Transfer in progress.',
        body: 'The registry has the request. Your current registrar may email the domain’s owner to approve it; if they don’t answer, the registry completes the transfer after five days. This page updates when it lands.',
      }
    case 'transfer_rejected':
      return { title: 'Transfer refused.', body: `${failureReason(domain.failureCode)} ${refund}` }
    case 'transfer_cancelled':
      return {
        title: 'Transfer cancelled.',
        body: `${failureReason(domain.failureCode)} ${refund}`,
      }
    default:
      return domain.testMode
        ? {
            title: 'Sandbox transfer.',
            body: 'Transferred in the registrar’s test system from a test payment. It does not work on the internet.',
          }
        : null
  }
}

export function registrationNote(domain: Subject): Note | null {
  if (domain.source === 'demo') {
    return domain.status === 'pending'
      ? { title: 'Demo domain.', body: 'It is never registered.' }
      : null
  }
  if (domain.source === 'transfer') return transferNote(domain)
  if (domain.status === 'pending') {
    return domain.testMode
      ? {
          title: 'Registering in the sandbox.',
          body: 'This was a test payment, so it goes to the registrar’s test system, not the live registry. It will not work on the internet.',
        }
      : {
          title: 'Registering.',
          body: 'Your payment is in and the registration is queued. This page shows the result once the registry confirms it.',
        }
  }
  if (domain.status === 'registration_failed') {
    return {
      title: 'Registration failed.',
      body: `${failureReason(domain.failureCode)} ${
        domain.testMode
          ? 'This was a test payment, so no money moved.'
          : 'We’ll refund what you paid for it.'
      }`,
    }
  }
  if (domain.testMode) {
    return {
      title: 'Sandbox registration.',
      body: 'Registered in the registrar’s test system from a test payment. It does not work on the internet.',
    }
  }
  return null
}

export function nameserverNote(
  domain: Subject & { pendingNameservers: string[] | null },
): Note | null {
  if (isTransferInProgress(domain.status)) {
    return {
      title: 'Transfer in progress.',
      body: 'The domain keeps the nameservers it has now. You can change them here once the transfer completes.',
    }
  }
  const requested = domain.pendingNameservers?.join(', ')
  if (!requested) return null
  if (domain.source === 'demo') {
    return {
      title: 'Demo domain.',
      body: `Requested: ${requested}. Nothing is sent to a registry.`,
    }
  }
  if (domain.status === 'pending') {
    return {
      title: 'Waiting for registration.',
      body: `Applied straight after the domain is registered: ${requested}.`,
    }
  }
  if (domain.status !== 'active') return null
  return { title: 'Sent to the registry.', body: `Waiting to be applied: ${requested}.` }
}
