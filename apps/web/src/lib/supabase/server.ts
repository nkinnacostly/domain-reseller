import type { Database } from '@dr/db/types'
import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { env } from '@/lib/env'
import { forwardedAuthHeaders } from './forwarded'

/**
 * Server client bound to the request's cookies. Acts AS THE USER — RLS applies.
 * This is the default for Server Components, Route Handlers and Server Actions.
 */
export async function createClient() {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()])

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      // Sessions record the person's browser and address, not our server's (FR-A5).
      global: { headers: forwardedAuthHeaders(requestHeaders) },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Called from a Server Component — the proxy refreshes the session instead.
          }
        },
      },
    },
  )
}
