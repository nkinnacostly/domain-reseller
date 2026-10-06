import type { MailDatabase } from '@dr/db'
import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * Cookie-free client, schema `mail`, for what is the same for everyone —
 * the plans on the pricing page. Reading cookies would make the page dynamic;
 * this keeps it prerendered behind `'use cache'`. Publishable key only, so
 * RLS applies: anon reads `mail.plans` and nothing else.
 */
export function createPublicClient() {
  return createClient<MailDatabase, 'mail'>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { db: { schema: 'mail' }, auth: { autoRefreshToken: false, persistSession: false } },
  )
}
