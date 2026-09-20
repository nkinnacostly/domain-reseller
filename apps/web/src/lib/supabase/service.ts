import 'server-only'

import type { Database } from '@dr/db/types'
import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * Cookie-free service client for server-side reads of non-public data.
 *
 * Used by the pricing path, which needs `pricing_settings` — margin is
 * commercially sensitive and must never be readable with the publishable key.
 * Being cookie-free means pages using it can still be prerendered and cached.
 *
 * `server-only` turns a client-side import into a build error.
 */
export function createServiceClient() {
  const secretKey = env.SUPABASE_SECRET_KEY
  if (!secretKey) throw new Error('SUPABASE_SECRET_KEY is not set')

  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
