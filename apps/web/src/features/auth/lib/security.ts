/**
 * The rules that stand between an email compromise and a stolen domain.
 *
 * Email is the weakest link in account security: whoever reads someone's
 * inbox can reset their password or sign in by link. So (PRD FR-A3, FR-A6):
 *
 * - sensitive operations need a second factor verified in the last 15 minutes;
 * - they are held for 24 hours after a password reset;
 * - two-factor settings can only change in a session that began with the
 *   password — not one that came from an email link.
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
