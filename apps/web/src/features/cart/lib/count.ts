'use client'

import { useEffect, useState } from 'react'
import { CART_COUNT_COOKIE } from './token-names'

/**
 * The header's cart badge. Prerendered pages cannot ask the server who is
 * looking, so the count travels in a small readable cookie, and in-page
 * changes are announced with an event. A hint only — the cart page is the
 * source of truth, and corrects the cookie whenever it renders.
 */
export const CART_COUNT_EVENT = 'cart:count'

function readCookie(): number {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CART_COUNT_COOKIE}=(\\d+)`))
  return match ? Number(match[1]) : 0
}

export function announceCartCount(count: number) {
  window.dispatchEvent(new CustomEvent(CART_COUNT_EVENT, { detail: count }))
}

export function useCartCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    setCount(readCookie())
    const onChange = (event: Event) => setCount((event as CustomEvent<number>).detail)
    window.addEventListener(CART_COUNT_EVENT, onChange)
    return () => window.removeEventListener(CART_COUNT_EVENT, onChange)
  }, [])
  return count
}

/** Rendered by the cart page: makes the cookie and badge match the real cart. */
export function CartCountSync({ count }: { count: number }) {
  useEffect(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: a display hint, not state we own elsewhere
    document.cookie = `${CART_COUNT_COOKIE}=${count}; path=/; max-age=${60 * 60 * 24 * 60}; samesite=lax`
    announceCartCount(count)
  }, [count])
  return null
}
