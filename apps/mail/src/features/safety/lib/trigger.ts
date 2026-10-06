import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * The worker's ping to apply queued tenant changes (MAIL-SPEC §7.4):
 * `POST /api/safety/apply` with `Authorization: Bearer <MAIL_SAFETY_SECRET>`.
 * The route only applies what SQL already has queued, so the secret lets its
 * holder ask "now, please" and nothing more — a replay asks again and changes
 * nothing. Compared in constant time, by digest, so the length leaks nothing.
 */

export const SAFETY_SECRET_MIN_CHARS = 32

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()

export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < SAFETY_SECRET_MIN_CHARS || !header) return false
  const match = /^Bearer\s+(\S+)$/.exec(header.trim())
  if (!match?.[1]) return false
  return timingSafeEqual(digest(match[1]), digest(secret))
}
