import 'server-only'

import { cache } from 'react'
import type { MailSessionClient } from '@/lib/supabase/server'
import { createClient } from '@/lib/supabase/server'

/**
 * When the person last reset their password — the start of the shop's
 * 24-hour hold (FR-A6), which Mail honours because the sign-in is shared
 * (MAIL-SPEC M5). Read as the person (RLS: their own profile row). An
 * unreadable answer counts as a hold just started: a check we cannot make
 * refuses, it never waves through.
 */
export async function readResetHold(
  supabase: MailSessionClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .schema('public')
    .from('profiles')
    .select('password_reset_at')
    .eq('id', userId)
    .maybeSingle()
  if (error) return new Date().toISOString()
  return data?.password_reset_at ?? null
}

/** The signed-in person, once per request; null when signed out. */
export const getSessionUser = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
})
