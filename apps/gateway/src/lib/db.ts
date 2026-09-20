import { createClient } from '@supabase/supabase-js'

/**
 * Service client for jobs. Bypasses RLS by design — there is no client-side
 * path to the catalogue or to pricing settings.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}
