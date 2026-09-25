import 'server-only'

import { cookies, headers } from 'next/headers'
import { clientKey } from '@/lib/client-ip'
import { env } from '@/lib/env'
import { addressKey, LIMITS, withinLimit } from '@/lib/rate-limit'
import { isTurnstileEnabled } from '@/lib/turnstile'
import { HUMAN_PASS_COOKIE, isValidHumanPass } from '../lib/human-pass'

/**
 * Passes are signed with the secret lib/client-ip.ts hashes addresses with —
 * it never leaves the server. Without it there is nothing to sign with, and
 * no pass is issued or accepted.
 */
export function humanPassSecret(): string | null {
  return env.SUPABASE_SECRET_KEY ?? null
}

/** Whether this request carries a live search pass issued to this address (SEC-9). */
export async function hasHumanPass(): Promise<boolean> {
  const secret = humanPassSecret()
  if (!secret) return false
  const [store, requestHeaders] = await Promise.all([cookies(), headers()])
  return isValidHumanPass(
    store.get(HUMAN_PASS_COOKIE)?.value,
    secret,
    clientKey(requestHeaders),
    Math.floor(Date.now() / 1000),
  )
}

/**
 * `ok` — search; `challenge` — past the free allowance, and a Turnstile check
 * would lift it; `limited` — past what is allowed, so wait. Without Turnstile
 * there is no check to offer, so the free allowance simply applies.
 */
export type SearchAllowance = 'ok' | 'challenge' | 'limited'

/**
 * Counts this search against the caller's address (SEC-9, FR-PUB2): one count,
 * judged against the free allowance, or the larger one a pass earns. A
 * refusal counts too, so waiting is what clears it.
 */
export async function searchAllowance(): Promise<SearchAllowance> {
  const passed = await hasHumanPass()
  const limit = passed ? LIMITS.searchWithPass : LIMITS.search
  if (await withinLimit(await addressKey('search'), limit)) return 'ok'
  return !passed && isTurnstileEnabled() ? 'challenge' : 'limited'
}
