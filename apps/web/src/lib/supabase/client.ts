'use client'

import type { Database } from '@dr/db/types'
import { createBrowserClient } from '@supabase/ssr'
import { env } from '@/lib/env'

/** Browser client. Anon key only — every read is gated by RLS. */
export function createClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}
