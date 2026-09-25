import 'server-only'

import { clientAddress } from '@/lib/client-ip'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Cloudflare Turnstile, verified on our server (PRD SEC-9): the forms that
 * send email — each costs Brevo quota and can be aimed at someone else's
 * inbox — and search past its free allowance, which protects the supplier's
 * two requests in flight.
 *
 * Not Supabase Auth's built-in captcha: e2e and production share one hosted
 * project, so a captcha secret there would refuse every e2e sign-in.
 *
 * Both keys or neither. Until the owner sets them the site works as before —
 * no widget, no check — and production says so in the log, once per process.
 */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Cloudflare gives up on a token after 300 s; an answer after 10 s is not coming. */
export const VERIFY_TIMEOUT_MS = 10_000

/** Cloudflare's documented maximum; anything longer is not a token. */
export const MAX_TOKEN_LENGTH = 2048

export type HumanCheck =
  /** `skipped`: Turnstile is not configured, so nothing was checked. */
  | { ok: true; skipped: boolean }
  /**
   * `refused` — no token, or Cloudflare said no (bad, expired or used twice);
   * `unanswered` — Cloudflare could not be asked, so we refuse rather than
   * wave everyone through while it is away.
   */
  | { ok: false; reason: 'refused' | 'unanswered' }

let reportedMissing = false

function secretKey(): string | null {
  const secret = env.TURNSTILE_SECRET_KEY
  // The site key draws the widget; without it no browser can send a token,
  // and requiring one would refuse every sign-up.
  if (secret && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) return secret
  if (env.NODE_ENV === 'production' && !reportedMissing) {
    reportedMissing = true
    logger.error(
      { hasSiteKey: Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY), hasSecretKey: Boolean(secret) },
      'Turnstile is not configured: sign-up, email links and search run without a bot check (SEC-9)',
    )
  }
  return null
}

/** Whether the check runs at all — both keys set. */
export function isTurnstileEnabled(): boolean {
  return secretKey() !== null
}

/**
 * Asks Cloudflare whether `token` came from a person, for this request. The
 * token is never logged: until it is spent, it is a pass.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  requestHeaders: Headers,
): Promise<HumanCheck> {
  const secret = secretKey()
  if (!secret) return { ok: true, skipped: true }
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'refused' }

  const form = new URLSearchParams({ secret, response: token })
  const remoteip = clientAddress(requestHeaders)
  if (remoteip) form.set('remoteip', remoteip)

  let answer: { success?: unknown; 'error-codes'?: unknown } | null
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (!response.ok) {
      logger.error({ status: response.status }, 'Turnstile siteverify failed; refusing')
      return { ok: false, reason: 'unanswered' }
    }
    answer = await response.json()
  } catch (err) {
    logger.error({ err: (err as Error).name }, 'Turnstile siteverify unreachable; refusing')
    return { ok: false, reason: 'unanswered' }
  }

  if (answer?.success === true) return { ok: true, skipped: false }

  const codes = Array.isArray(answer?.['error-codes']) ? answer['error-codes'].map(String) : []
  // A bad or missing secret is ours to fix, not the visitor's: say so loudly.
  if (codes.some((code) => code.includes('secret'))) {
    logger.error({ codes }, 'Turnstile rejected our secret key; refusing')
    return { ok: false, reason: 'unanswered' }
  }
  if (codes.includes('internal-error')) return { ok: false, reason: 'unanswered' }
  return { ok: false, reason: 'refused' }
}

export const HUMAN_CHECK_REFUSED = "We couldn't confirm you're a person. Try again."
export const HUMAN_CHECK_UNANSWERED =
  "We couldn't confirm you're a person just now — the check didn't answer. Try again in a moment."

/** What to tell someone whose check did not pass. */
export function humanCheckError(check: Extract<HumanCheck, { ok: false }>): string {
  return check.reason === 'unanswered' ? HUMAN_CHECK_UNANSWERED : HUMAN_CHECK_REFUSED
}
