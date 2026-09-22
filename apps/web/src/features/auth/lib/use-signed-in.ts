'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Whether this browser holds a session — a hint for the marketing header only.
 *
 * Marketing pages are prerendered and shared by everyone, so the server cannot
 * know who is looking. This reads the session cookie after hydration: fine for
 * choosing between "Login" and "Your domains", never for access control (the
 * proxy and RLS do that).
 */
export function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getSession().then(({ data }) => setSignedIn(Boolean(data.session)))
    const { data } = supabase.auth.onAuthStateChange((_event, session) =>
      setSignedIn(Boolean(session)),
    )
    return () => data.subscription.unsubscribe()
  }, [])

  return signedIn
}
