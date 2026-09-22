/**
 * Supabase auth error codes → what we tell people (PRD UX-7: what happened,
 * why, what to do next). Raw provider messages never reach the page.
 */
const MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password don't match an account. Check both and try again.",
  email_not_confirmed:
    'Confirm your email first — open the link we sent you, then sign in. It can take a minute to arrive.',
  over_email_send_rate_limit:
    "We've sent several emails to this address already. Wait a few minutes before asking for another.",
  over_request_rate_limit: 'Too many attempts in a short time. Wait a minute, then try again.',
  weak_password:
    'Choose a stronger password — longer, and not one you have used on another website.',
  same_password: "That's your current password. Choose a new one.",
  mfa_verification_failed:
    "That code didn't work. Codes change every 30 seconds — enter the newest one from your app.",
  mfa_challenge_expired: 'That code expired. Enter the newest one from your app.',
  user_banned: 'This account has been suspended. Contact support and we will explain why.',
  signup_disabled: 'New sign-ups are paused right now. Please try again later.',
  email_address_invalid: 'Enter a valid email address.',
  otp_expired: 'That link has expired or was already used. Ask for a new one below.',
  session_not_found: 'Your session has ended. Sign in again to continue.',
  too_many_enrolled_mfa_factors:
    'This account already has the maximum number of authenticator apps. Remove one first.',
}

export const FALLBACK_MESSAGE = 'Something went wrong on our side. Please try again in a moment.'

export function authMessage(code: string | undefined): string {
  return (code && MESSAGES[code]) || FALLBACK_MESSAGE
}
