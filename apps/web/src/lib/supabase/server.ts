import type { Database } from '@dr/db/types'
import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { env } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from './cookies'
import { forwardedAuthHeaders } from './forwarded'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Server client bound to the request's cookies. Acts AS THE USER — RLS applies.
 * This is the default for Server Components, Route Handlers and Server Actions.
 *
 * `requestId` (a uuid) travels as `x-request-id`, so an admin audit row can be
 * joined to the action's logs (ADMIN-SPEC §2.5); anything else is dropped.
 */
export async function createClient(options: { requestId?: string } = {}) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()])
  const global = forwardedAuthHeaders(requestHeaders)
  if (options.requestId && UUID.test(options.requestId)) global['x-request-id'] = options.requestId

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      // Sessions record the person's browser and address, not our server's (FR-A5).
      global: { headers: global },
      // No script on any page can read the refresh token (ADMIN-SPEC §5.1).
      cookieOptions: SESSION_COOKIE_OPTIONS,
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
