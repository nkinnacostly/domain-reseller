import { createHash, randomBytes } from 'node:crypto'

/**
 * An anonymous cart is found by a random token in an httpOnly cookie. The
 * database keeps only its SHA-256, so a leaked table cannot be replayed as
 * cookies.
 */
export { CART_COOKIE, CART_COUNT_COOKIE } from './token-names'

/** 60 days: long enough to come back to a cart, short enough not to linger. */
export const CART_COOKIE_MAX_AGE = 60 * 60 * 24 * 60

export function newCartToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashCartToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
