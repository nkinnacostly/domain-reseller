/**
 * The rules that stand between an email compromise and a taken-over account,
 * the shop's (PRD FR-A3, FR-A6), because Supabase Auth is shared (MAIL-SPEC
 * M5): one password and one authenticator for Mail and the shop.
 *
 * - two-factor settings change only in a session started with the password
 *   or Google — not one from an email link, which is exactly what someone
 *   reading the inbox holds;
 * - turning two-factor off needs a code from the last 15 minutes;
 * - after a password reset, from either product, two-factor changes wait 24
 *   hours (`public.profiles.password_reset_at`, the shop's hold).
 */

export const RESET_HOLD_HOURS = 24
export const STEP_UP_MAX_AGE_MINUTES = 15

export type AuthMethod = { method: string; timestamp: number }

const names = (methods: readonly (AuthMethod | string)[]) =>
  methods.map((entry) => (typeof entry === 'string' ? entry : entry.method))

/** When the post-reset hold ends, or null if there is none. */
export function resetHoldUntil(passwordResetAt: string | null, now: Date): Date | null {
  if (!passwordResetAt) return null
  const until = new Date(new Date(passwordResetAt).getTime() + RESET_HOLD_HOURS * 3_600_000)
  return until > now ? until : null
}

/** Started with the password or Google (`oauth`), never only an email link. */
export function startedWithStrongSignIn(methods: readonly (AuthMethod | string)[]): boolean {
  return names(methods).some((method) => method === 'password' || method === 'oauth')
}

/** Started from an email link — a password reset. */
export function startedFromEmailLink(methods: readonly (AuthMethod | string)[]): boolean {
  const used = names(methods)
  return used.includes('otp') && !used.includes('password') && !used.includes('oauth')
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
  return `For your security, two-factor changes are paused for ${RESET_HOLD_HOURS} hours after a password reset — until ${holdFormat.format(until)}.`
}

export const NEEDS_STRONG_SIGN_IN =
  'Sign in with your password or Google to change two-factor settings. Sessions started from an email link cannot change security settings.'
