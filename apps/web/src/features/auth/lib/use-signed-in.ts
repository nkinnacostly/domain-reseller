'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { hasSignedInHint } from './signed-in-hint'

/**
 * Whether this browser holds a session — a hint for the marketing header only.
 *
 * Marketing pages are prerendered and shared by everyone, so the server cannot
 * know who is looking. The session cookies are httpOnly (ADMIN-SPEC §5.1), so
 * this reads the proxy's `dr_signed_in` hint after hydration, after each
 * navigation, and when the tab comes back into view: fine for choosing
 * between "Login" and "Your domains", never for access control (the proxy
 * and RLS do that).
 */
export function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false)
  const pathname = usePathname()

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the page changes
  useEffect(() => {
    const read = () => setSignedIn(hasSignedInHint(document.cookie))
    read()
    document.addEventListener('visibilitychange', read)
    return () => document.removeEventListener('visibilitychange', read)
  }, [pathname])

  return signedIn
}
