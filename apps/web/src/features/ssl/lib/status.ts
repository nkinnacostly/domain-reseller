import { bareName, type SslStatus } from '@dr/shared'

/**
 * How a certificate reads to its owner (FR-SSL-7): a short label for the
 * pill, a sentence for where it stands, and what — if anything — they do
 * next. Pure, so every state is tested.
 */

export type CertificateTone = 'waiting' | 'action' | 'good' | 'problem'

export type CertificateState = {
  label: string
  tone: CertificateTone
  /** True while something on our side or the CA's is moving: the page refreshes itself. */
  settling: boolean
}

const STATES: Record<SslStatus, CertificateState> = {
  pending: { label: 'Ordering', tone: 'waiting', settling: true },
  awaiting_setup: { label: 'Set it up', tone: 'action', settling: false },
  setting_up: { label: 'Sending set-up', tone: 'waiting', settling: true },
  awaiting_validation: { label: 'Waiting for approval', tone: 'action', settling: true },
  issued: { label: 'Issued', tone: 'good', settling: false },
  reissuing: { label: 'Reissuing', tone: 'waiting', settling: true },
  revoked: { label: 'Revoked', tone: 'problem', settling: false },
  cancelled: { label: 'Cancelled', tone: 'problem', settling: false },
  failed: { label: 'Not ordered', tone: 'problem', settling: false },
}

export function certificateState(
  status: string,
  expiresAt: string | null,
  now: Date,
): CertificateState {
  const known = STATES[status as SslStatus] ?? { label: status, tone: 'waiting', settling: false }
  if (status === 'issued' && expiresAt && new Date(expiresAt) <= now) {
    return { label: 'Expired', tone: 'problem', settling: false }
  }
  return known
}

/** Whole days until an expiry, never negative; null without a date. */
export function daysLeft(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 86_400_000))
}

/** A certificate this close to its expiry is worth reissuing now (its subscription allowing). */
export const REISSUE_SOON_DAYS = 30

/** Our code for a refused set-up or reissue → what the customer can do about it (N10). */
const PROBLEMS: Record<string, string> = {
  CSR_NAME_MISMATCH:
    'The certificate request (CSR) is for a different name. Make a new one for the name this certificate is for.',
  CSR_NOT_WILDCARD:
    'A wildcard certificate needs a request (CSR) whose name starts with "*." — for example *.example.com.',
  CSR_INVALID:
    'The certificate authority could not read the request (CSR). Make a new one and paste it whole.',
  APPROVER_INVALID: 'The approval address was not accepted. Choose one from the list.',
  VALIDATION_METHOD_UNSUPPORTED:
    'That way of proving control is not available. Choose the approval email.',
  WEB_SERVER_UNSUPPORTED: 'That server type was not accepted. Choose Apache or Microsoft IIS.',
  SSL_INVALID_REQUEST:
    'The certificate authority’s supplier refused some of the details. Check the contact details — city and state up to 20 characters, postcode up to 10 — and try again.',
  SSL_WRONG_STATE:
    'The certificate is not in a state that allows this. Refresh the page; if it stays, contact us.',
  NOT_SUPPORTED:
    'The supplier does not offer this for this certificate. Contact us and we will sort it out.',
  SUPPLIER_UNAVAILABLE:
    'We could not reach the certificate supplier after several tries. Send it again, or contact us if it keeps happening.',
}

export function setupProblem(code: string | null | undefined): string | null {
  if (!code) return null
  return (
    PROBLEMS[code] ??
    'The certificate authority’s supplier did not accept it. Check the details and send them again, or contact us.'
  )
}

/** The name the approval email is about: the bare domain for a wildcard. */
export function approvalDomain(commonName: string): string {
  return bareName(commonName)
}
