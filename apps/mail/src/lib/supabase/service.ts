import 'server-only'

import type { MailDatabase } from '@dr/db'
import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * SECRET-KEY CLIENT, schema `mail` — for the v1 API, whose callers carry an
 * API key, not a session. It bypasses RLS, but in schema `mail` the secret
 * key may only call the functions granted to service_role (authenticate_key,
 * enqueue_email, get_email…): migration 44 grants it no table at all, so
 * every read and write is scoped by an SQL function, never by this code.
 *
 * `server-only` turns a browser import into a build error (N6).
 */
export function createServiceClient() {
  const secretKey = env.SUPABASE_SECRET_KEY
  if (!secretKey) throw new Error('SUPABASE_SECRET_KEY is not set')

  return createClient<MailDatabase, 'mail'>(env.NEXT_PUBLIC_SUPABASE_URL, secretKey, {
    db: { schema: 'mail' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export type MailServiceClient = ReturnType<typeof createServiceClient>
