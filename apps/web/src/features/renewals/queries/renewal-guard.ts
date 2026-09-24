import 'server-only'

import type { User } from '@supabase/supabase-js'
import type { createClient } from '@/lib/supabase/server'

/**
 * The one place a bulk renewal (FR-P4, FR-P5) is checked for the account
 * before anything is priced or created — `placeRenewals` asks it first.
 *
 * Kept apart from `guardSensitiveBulkChange` on purpose: rules that hold
 * back registry changes, such as FR-A2's two-factor requirement for larger
 * portfolios, must never stop someone paying to keep their domains. Only a
 * rule about paying belongs here.
 */
export async function guardBulkRenewal(_ctx: {
  supabase: Awaited<ReturnType<typeof createClient>>
  user: Pick<User, 'id' | 'email'>
}): Promise<{ error: string } | null> {
  return null
}
