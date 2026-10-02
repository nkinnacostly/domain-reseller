import 'server-only'

import { cookies } from 'next/headers'
import { env } from '@/lib/env'
import {
  CART_COOKIE,
  CART_COOKIE_MAX_AGE,
  CART_COUNT_COOKIE,
  hashCartToken,
  newCartToken,
} from '../lib/token'
import { currentOwner, findCartId, mergeAnonymousCart, type Owner } from './store'

/**
 * Who owns the cart a write goes to — shared by the domain and SSL cart
 * actions. Not in a 'use server' file: everything exported from one of
 * those is callable from the browser.
 */

export async function setCountCookie(count: number) {
  ;(await cookies()).set(CART_COUNT_COOKIE, String(count), {
    path: '/',
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: CART_COOKIE_MAX_AGE,
  })
}

/** The shopper's cart owner, minting an anonymous cart cookie if there is none. */
export async function ownerForWrite(): Promise<Owner> {
  const { owner, anonToken } = await currentOwner()
  if (owner?.kind === 'user') {
    if (anonToken) {
      await mergeAnonymousCart(anonToken, owner.userId)
      ;(await cookies()).delete(CART_COOKIE)
    }
    return owner
  }
  if (owner) return owner

  const token = newCartToken()
  ;(await cookies()).set(CART_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: CART_COOKIE_MAX_AGE,
  })
  return { kind: 'anon', tokenHash: hashCartToken(token) }
}

/** The cart the shopper already has — lines can only be changed in your own. */
export async function existingCartId(): Promise<string | null> {
  const { owner } = await currentOwner()
  return owner ? findCartId(owner) : null
}
