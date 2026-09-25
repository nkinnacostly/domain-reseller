import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The search pass (SEC-9): proof, for two hours, that this address passed
 * Turnstile, which lifts its search allowance (LIMITS.searchWithPass) and
 * lets bulk search start.
 *
 * `<expiry>.<mac>`, where the MAC is an HMAC over the expiry and the caller's
 * `clientKey` under a server secret. So it cannot be forged or extended, and
 * a pass copied to another connection is worth nothing there. It holds no
 * address — `clientKey` is already a keyed hash of one.
 */
export const HUMAN_PASS_COOKIE = 'dr_search_pass'
export const HUMAN_PASS_SECONDS = 2 * 60 * 60

/** Keeps these MACs apart from anything else the same secret signs. */
const PURPOSE = 'search-pass:v1'

function mac(secret: string, expires: number, clientKey: string): string {
  return createHmac('sha256', secret)
    .update(`${PURPOSE}:${expires}:${clientKey}`)
    .digest('base64url')
}

export function signHumanPass(secret: string, clientKey: string, nowSeconds: number): string {
  const expires = nowSeconds + HUMAN_PASS_SECONDS
  return `${expires}.${mac(secret, expires, clientKey)}`
}

export function isValidHumanPass(
  value: string | undefined,
  secret: string,
  clientKey: string,
  nowSeconds: number,
): boolean {
  const match = /^(\d{1,12})\.([\w-]{43})$/.exec(value ?? '')
  if (!match?.[1] || !match[2]) return false
  const expires = Number(match[1])
  // Never longer than we issue: a far-off expiry means it was not ours.
  if (expires <= nowSeconds || expires > nowSeconds + HUMAN_PASS_SECONDS) return false
  const expected = Buffer.from(mac(secret, expires, clientKey))
  const given = Buffer.from(match[2])
  return expected.length === given.length && timingSafeEqual(expected, given)
}
