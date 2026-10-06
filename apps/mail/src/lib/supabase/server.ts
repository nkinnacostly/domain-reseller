import type { Database } from '@dr/db'
import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { env } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from './cookies'
import { forwardedAuthHeaders } from './forwarded'

/**
 * Server client bound to the request's cookies, on schema `mail`. Acts AS THE
 * USER — RLS applies: members read their own account's rows by role. The
 * default for Server Components, Route Handlers and Server Actions.
 *
 * Supabase Auth is the shop's (MAIL-SPEC M5): one `auth.users`, but the
 * session cookie is this host's own.
 */
export async function createClient() {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()])

  return createServerClient<Database, 'mail'>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      db: { schema: 'mail' },
      // Sessions record the person's browser and address, not our server's.
      global: { headers: forwardedAuthHeaders(requestHeaders) },
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

export type MailSessionClient = Awaited<ReturnType<typeof createClient>>
