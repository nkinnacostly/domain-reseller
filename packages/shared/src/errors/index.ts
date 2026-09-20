/**
 * Error taxonomy. The UI never shows a raw supplier string — PRD §13.8.
 * Every supplier/provider error is mapped to one of these codes at the boundary.
 */
export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'MFA_REQUIRED'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CONFLICT'

export type GatewayErrorCode =
  | 'SUPPLIER_AUTH'
  | 'SUPPLIER_IP_BLOCKED'
  | 'SUPPLIER_INSUFFICIENT_FUNDS'
  | 'SUPPLIER_UNAVAILABLE'
  | 'TLD_UNSUPPORTED'
  | 'DOMAIN_TAKEN'
  | 'DOMAIN_NOT_FOUND'
  | 'CONTACT_INVALID'
  | 'TRANSFER_INELIGIBLE'
  | 'NAMESERVER_INVALID'
  | 'REGISTRATION_FAILED'
  | 'RENEWAL_FAILED'

export class AppError extends Error {
  readonly code: AppErrorCode
  constructor(code: AppErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppError'
    this.code = code
  }
}

export class GatewayError extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(code: string, message: string, options?: ErrorOptions & { retryable?: boolean }) {
    super(message, options)
    this.name = 'GatewayError'
    this.code = code
    this.retryable = options?.retryable ?? false
  }
}

/** Supplier code → our code. Anything unmapped is treated as retryable-unknown. */
const SUPPLIER_CODE_MAP: Record<string, { code: GatewayErrorCode; retryable: boolean }> = {
  CREDENTIALS: { code: 'SUPPLIER_AUTH', retryable: false },
  API_301: { code: 'SUPPLIER_IP_BLOCKED', retryable: false },
  API_310: { code: 'TLD_UNSUPPORTED', retryable: false },
  API_350: { code: 'SUPPLIER_INSUFFICIENT_FUNDS', retryable: true },
  DOMAIN_REGISTER: { code: 'REGISTRATION_FAILED', retryable: false },
  DOMAIN_RENEW: { code: 'RENEWAL_FAILED', retryable: true },
  DOMAIN_DETAILS: { code: 'DOMAIN_NOT_FOUND', retryable: false },
  CONTACT_INFO: { code: 'CONTACT_INVALID', retryable: false },
  CONTACT_SAVE: { code: 'CONTACT_INVALID', retryable: false },
}

/** Messages shown to users. Say what happened, why, and what to do next (UX-7). */
const USER_MESSAGE: Record<GatewayErrorCode, string> = {
  SUPPLIER_AUTH: 'We hit a problem on our end. Nothing was charged — our team has been alerted.',
  SUPPLIER_IP_BLOCKED:
    'We hit a problem on our end. Nothing was charged — our team has been alerted.',
  SUPPLIER_INSUFFICIENT_FUNDS:
    "We couldn't complete this right now and you haven't been charged. Please try again in a few minutes.",
  SUPPLIER_UNAVAILABLE:
    "This is taking longer than usual. We'll email you the moment it completes.",
  TLD_UNSUPPORTED: "We don't support this extension yet. Tell us if you'd like us to add it.",
  DOMAIN_TAKEN:
    'That domain was registered by someone else moments ago. Any payment has been refunded to your wallet.',
  DOMAIN_NOT_FOUND: "We couldn't find that domain on your account.",
  CONTACT_INVALID: 'Some contact details were rejected by the registry. Check the fields below.',
  TRANSFER_INELIGIBLE: 'This domain cannot be transferred yet.',
  NAMESERVER_INVALID: "One of those nameservers doesn't exist. Check the spelling.",
  REGISTRATION_FAILED: "We couldn't complete the registration. You have not been charged.",
  RENEWAL_FAILED: "We couldn't renew this domain. Please try again or contact support.",
}

export function mapSupplierError(supplierCode: string, fallbackMessage?: string): GatewayError {
  const mapped = SUPPLIER_CODE_MAP[supplierCode]
  if (!mapped) {
    return new GatewayError(
      'SUPPLIER_UNAVAILABLE',
      fallbackMessage ?? USER_MESSAGE.SUPPLIER_UNAVAILABLE,
      { retryable: true },
    )
  }
  return new GatewayError(mapped.code, USER_MESSAGE[mapped.code], { retryable: mapped.retryable })
}

export function userMessageFor(code: GatewayErrorCode): string {
  return USER_MESSAGE[code]
}
