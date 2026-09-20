import type { Database } from '@dr/db/types'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * Cookie-free client for public, identical-for-everyone data.
 *
 * The cookie-bound server client reads `cookies()`, which makes any page using
 * it dynamic. Data that is the same for every visitor — the active exchange
 * rate, the TLD catalogue — has no business forcing that, and reading it
 * through a user's session is misleading about who it belongs to.
 *
 * Anon key only, so RLS still applies: this can only see rows a policy exposes
 * publicly.
 */
export function createPublicClient() {
  return createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}
