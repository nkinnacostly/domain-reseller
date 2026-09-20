import 'server-only'

import type { Database } from '@dr/db/types'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * SECRET-KEY CLIENT — BYPASSES RLS.
 *
 * Rules (PRD SEC-6):
 *   • Never import this from a Client Component or anything reachable by the browser.
 *     The `server-only` import above turns a mistake into a build error.
 *   • Use only where RLS genuinely cannot express the rule: webhook handlers,
 *     reconciliation jobs, admin tooling with its own authorisation check.
 *   • Always perform your own authorisation check first. There is no safety net here.
 */
export function createAdminClient() {
  const secretKey = env.SUPABASE_SECRET_KEY
  if (!secretKey) {
    throw new Error('SUPABASE_SECRET_KEY is not set — the admin client cannot be created.')
  }

  return createSupabaseClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
