import type { LocalStatus } from '@dr/shared'

/**
 * The rules that stand between an email compromise and a stolen domain.
 *
 * Email is the weakest link in account security: whoever reads someone's
 * inbox can reset their password or sign in by link. So (PRD FR-A3, FR-A6):
 *
 * - sensitive operations need a second factor verified in the last 15 minutes;
 * - they are held for 24 hours after a password reset;
 * - two-factor settings can only change in a session that began with the
 *   password — not one that came from an email link;
 * - above ten domains two-factor is mandatory (FR-A2): new orders and
 *   transfers in wait until it is on.
 */

export const RESET_HOLD_HOURS = 24
export const STEP_UP_MAX_AGE_MINUTES = 15

export type AuthMethod = { method: string; timestamp: number }

/** When the post-reset hold ends, or null if there is none. */
export function resetHoldUntil(passwordResetAt: string | null, now: Date): Date | null {
  if (!passwordResetAt) return null
  const until = new Date(new Date(passwordResetAt).getTime() + RESET_HOLD_HOURS * 3_600_000)
  return until > now ? until : null
}

/** The session was started with the password, not an email link or OAuth. */
export function startedWithPassword(methods: readonly (AuthMethod | string)[]): boolean {
  return methods.some((entry) => (typeof entry === 'string' ? entry : entry.method) === 'password')
}

/** Started from an email link — a recovery or magic-link sign-in. */
export function startedFromEmailLink(methods: readonly (AuthMethod | string)[]): boolean {
  const names = methods.map((entry) => (typeof entry === 'string' ? entry : entry.method))
  return names.includes('otp') && !names.includes('password')
}

/** A second factor verified within the step-up window (FR-A3). */
export function hasFreshSecondFactor(
  methods: readonly (AuthMethod | string)[],
  now: Date,
): boolean {
  const cutoff = now.getTime() / 1000 - STEP_UP_MAX_AGE_MINUTES * 60
  return methods.some(
    (entry) => typeof entry !== 'string' && entry.method === 'totp' && entry.timestamp >= cutoff,
  )
}

const holdFormat = new Intl.DateTimeFormat('en-NG', {
  weekday: 'long',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Africa/Lagos',
})

export function describeHold(until: Date): string {
  return `For your security, changes like this are paused for ${RESET_HOLD_HOURS} hours after a password reset — until ${holdFormat.format(until)}.`
}

/**
 * FR-A2, SEC-1: two-factor is mandatory for an account holding more than
 * this many domains — a portfolio that size is worth stealing, and its owner
 * is worth phishing. Below it, two-factor stays optional. (The PRD's other
 * trigger, a wallet balance, waits for the wallet.)
 */
export const TWO_FACTOR_REQUIRED_ABOVE_DOMAINS = 10

/**
 * Statuses in which a domain is not the account's (PRD §10): gone from the
 * registry, moved to another registrar, never registered, or a transfer in
 * that was refused or cancelled — the domain stayed where it was. Everything
 * else counts as held — a registration or transfer under way included, since
 * it is paid for and about to be live. Demo rows never count: they are not
 * domains.
 */
export const NOT_HELD_STATUSES = [
  'released',
  'transferred_away',
  'registration_failed',
  'transfer_rejected',
  'transfer_cancelled',
  'closed',
] as const satisfies readonly LocalStatus[]

/** Whether an account holding this many domains must have two-factor on. */
export function twoFactorRequired(heldDomains: number): boolean {
  return heldDomains > TWO_FACTOR_REQUIRED_ABOVE_DOMAINS
}

/** Where two-factor is turned on. */
export const TWO_FACTOR_SETTINGS_HREF = '/app/settings#two-factor'

/**
 * Why a purchase is refused until two-factor is on, and what to do (FR-A2).
 * `notCharged` sits between the two, the way every checkout refusal reads.
 * Renewals are never refused: they protect what the account already holds.
 */
export function purchaseNeedsTwoFactor(kind: 'order' | 'transfer', notCharged: string): string {
  const what = kind === 'order' ? 'ordering more domains' : 'transferring more domains in'
  return `Accounts holding more than ${TWO_FACTOR_REQUIRED_ABOVE_DOMAINS} domains need two-factor authentication before ${what}. ${notCharged} Turn it on in Settings, under Two-factor authentication, then try again.`
}

/**
 * elevatedAction's refusal for an account with no authenticator at all —
 * "enter the code" would ask for something it does not have (SEC-2).
 */
export const SENSITIVE_CHANGE_NEEDS_TWO_FACTOR =
  'Changes like this need two-factor authentication on your account. Turn it on in Settings, under Two-factor authentication, then try again.'
