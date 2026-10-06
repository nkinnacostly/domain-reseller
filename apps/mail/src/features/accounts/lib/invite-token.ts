import { createHash, randomBytes } from 'node:crypto'

/**
 * Invitation tokens (MAIL-SPEC §9 `invites`: "hashed token, 7-day expiry").
 * 32 random bytes, URL-safe; the database keeps only the SHA-256 of the
 * token, so a leaked table invites nobody. The token itself is shown to the
 * inviter once, in the link, and never logged (N13). No pepper is needed: a
 * 256-bit random value cannot be guessed from its hash.
 */
const TOKEN_BYTES = 32
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, hash: hashInviteToken(token) }
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Whether a string could be one of our tokens — anything else is not looked up. */
export const isInviteToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN.test(value)

/** The link the inviter sends; the token rides in the query, as Supabase's own links do. */
export function inviteLink(origin: string, token: string): string {
  const url = new URL('/invite', origin)
  url.searchParams.set('token', token)
  return url.toString()
}
